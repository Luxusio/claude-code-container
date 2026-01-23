// src/remote.ts - ccc remote functionality for Tailscale + Mutagen sync

import {spawn, spawnSync} from "child_process";
import {existsSync, mkdirSync, readFileSync, writeFileSync} from "fs";
import {join, resolve} from "path";
import {homedir} from "os";
import {hashPath, getProjectId, EXCLUDE_ENV_KEYS, prompt} from "./utils.js";

// Re-export for tests
export {hashPath} from "./utils.js";

// === Types ===

interface RemoteConfig {
    host: string;
    user: string;
    remotePath: string;
}

// === Configuration ===

const dataDir = join(homedir(), ".ccc");
const remoteConfigDir = join(dataDir, "remote");

// === Tool Detection ===

export function checkTailscale(): {installed: boolean; version?: string} {
    const result = spawnSync("tailscale", ["version"], {encoding: "utf-8"});
    if (result.error || result.status !== 0) {
        return {installed: false};
    }
    const version = (result.stdout ?? "").split("\n")[0].trim();
    return {installed: true, version};
}

export function checkMutagen(): {installed: boolean; version?: string} {
    const result = spawnSync("mutagen", ["version"], {encoding: "utf-8"});
    if (result.error || result.status !== 0) {
        return {installed: false};
    }
    const version = (result.stdout ?? "").trim();
    return {installed: true, version};
}

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

// === Helpers ===

export function getProjectHash(projectPath: string): string {
    return hashPath(resolve(projectPath));
}

export function getMutagenSessionName(projectPath: string): string {
    return `ccc-${getProjectId(projectPath)}`;
}

// === Remote Container Functions ===

/**
 * Ensure remote ccc image exists, build if needed
 */
async function ensureRemoteImage(config: RemoteConfig): Promise<void> {
    // Check if image exists on remote
    const checkCmd = `docker images -q ccc`;
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
async function startRemoteContainer(config: RemoteConfig, projectId: string): Promise<string> {
    const containerName = `ccc-${projectId}`;

    // Build docker run command (no project volume, just credentials and mise cache)
    const dockerCmd = `docker run -d --name ${containerName} \
        --network host \
        -v ~/.ccc/claude:/claude \
        -v ~/.ccc/mise:/home/ccc/.local/share/mise \
        -v /var/run/docker.sock:/var/run/docker.sock \
        -e CLAUDE_CONFIG_DIR=/claude \
        -w /project/${projectId} \
        --pids-limit 512 \
        ccc sleep infinity 2>/dev/null || docker start ${containerName}`;

    const result = spawnSync("ssh", [
        `${config.user}@${config.host}`,
        dockerCmd
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
    return join(remoteConfigDir, `${hash}.json`);
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
    mkdirSync(remoteConfigDir, {recursive: true});
    const configPath = getConfigPath(projectPath);
    writeFileSync(configPath, JSON.stringify(config, null, 2));
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
    const createResult = spawnSync("mutagen", [
        "sync", "create",
        fullPath,
        `${config.user}@${config.host}:docker://${containerName}/project/${projectId}`,
        "--name", sessionName,
        "--ignore-vcs",
        "--ignore=node_modules",
        "--ignore=.git",
        "--ignore=dist",
        "--ignore=build",
        "--ignore=target",
        "--ignore=__pycache__",
        "--ignore=.next",
        "--ignore=.nuxt",
        "--ignore=vendor"
    ], {stdio: "inherit"});

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
        // Use saved config
        console.log(`Using saved config: ${config.user}@${config.host}`);
    } else if (host) {
        // Create/update config with provided host
        if (!isHostReachable(host)) {
            console.error(`Host ${host} is not reachable. Check if it's online and accessible.`);
            process.exit(1);
        }

        const defaultUser = process.env.USER || "user";
        const userInput = await prompt(`Remote user [${defaultUser}]: `);
        const user = userInput || defaultUser;

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

    try {
        // 1. Ensure ccc image exists on remote
        await ensureRemoteImage(config);

        // 2. Start container on remote (without project volume mount)
        console.log("Starting remote container...");
        const containerName = await startRemoteContainer(config, projectId);

        // 3. Create project directory in container
        await createContainerProjectDir(config, containerName, projectId);

        // 4. Ensure mutagen sync to container is running
        const sessionName = await ensureSync(fullPath, config, containerName);

        // 5. Wait for initial sync
        await waitForSync(sessionName);

        // 6. Run claude via docker exec
        console.log(`Connecting to ${config.host}...`);

        const claudeArgs = args.length > 0 ? args.join(" ") : "--dangerously-skip-permissions";

        // Collect environment variables to forward (exclude system vars)
        const envFlags: string[] = [];
        for (const [key, value] of Object.entries(process.env)) {
            if (value !== undefined && !EXCLUDE_ENV_KEYS.has(key)) {
                // Escape single quotes in value for shell safety
                const escapedValue = value.replace(/'/g, "'\\''");
                envFlags.push(`-e '${key}=${escapedValue}'`);
            }
        }
        const envString = envFlags.join(" ");

        const execCmd = `docker exec ${envString} -it ${containerName} sh -c "cd /project/${projectId} && mise trust . 2>/dev/null; mise install -y 2>/dev/null || true; claude ${claudeArgs}"`;

        const sshProcess = spawn("ssh", ["-t", `${config.user}@${config.host}`, execCmd], {
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
                console.log("Pausing sync...");
                spawnSync("mutagen", ["sync", "pause", sessionName], {stdio: "inherit"});
                console.log("Stopping container...");
                spawnSync("ssh", [`${config.user}@${config.host}`, `docker stop ${containerName}`], {stdio: "inherit"});
            }
        }

        process.exit(exitCode);
    } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
    }
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
        console.log(`  Container: ccc-${getProjectId(projectPath)}`);

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
