// src/remote.ts - ccc remote functionality for Tailscale + Mutagen sync

import {spawn, spawnSync} from "child_process";
import {createInterface} from "readline";
import {createHash} from "crypto";
import {existsSync, mkdirSync, readFileSync, writeFileSync} from "fs";
import {basename, join, resolve} from "path";
import {homedir} from "os";

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

export function hashPath(path: string): string {
    return createHash("sha256").update(path).digest("hex").slice(0, 12);
}

export function getProjectHash(projectPath: string): string {
    return hashPath(resolve(projectPath));
}

export function getMutagenSessionName(projectPath: string): string {
    const name = basename(resolve(projectPath)).toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const hash = getProjectHash(projectPath);
    return `ccc-${name}-${hash}`;
}

async function prompt(question: string): Promise<string> {
    const rl = createInterface({input: process.stdin, output: process.stdout});
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
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
 * Returns the session name.
 */
async function ensureSync(projectPath: string, config: RemoteConfig): Promise<string> {
    const fullPath = resolve(projectPath);
    const sessionName = getMutagenSessionName(fullPath);

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

    // Create new sync session
    console.log("Creating sync session...");
    console.log(`  Local:  ${fullPath}`);
    console.log(`  Remote: ${config.user}@${config.host}:${config.remotePath}`);

    const createResult = spawnSync("mutagen", [
        "sync", "create",
        fullPath,
        `${config.user}@${config.host}:${config.remotePath}`,
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
 * 1. Ensure mutagen sync is running
 * 2. Wait for initial sync
 * 3. SSH and run ccc on remote
 * 4. Cleanup prompt on exit
 */
export async function remoteExec(projectPath: string, host?: string, args: string[] = []): Promise<void> {
    const fullPath = resolve(projectPath);

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
        console.log(`Using saved config: ${config.user}@${config.host}:${config.remotePath}`);
    } else if (host) {
        // Create/update config with provided host
        if (!isHostReachable(host)) {
            console.error(`Host ${host} is not reachable. Check if it's online and accessible.`);
            process.exit(1);
        }

        const defaultUser = process.env.USER || "user";
        const userInput = await prompt(`Remote user [${defaultUser}]: `);
        const user = userInput || defaultUser;

        const defaultRemotePath = fullPath;
        const remotePathInput = await prompt(`Remote path [${defaultRemotePath}]: `);
        const remotePath = remotePathInput || defaultRemotePath;

        config = {host, user, remotePath};
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
        // 1. Ensure mutagen sync is running
        const sessionName = await ensureSync(fullPath, config);

        // 2. Wait for initial sync
        await waitForSync(sessionName);

        // 3. SSH and run ccc on remote
        console.log(`Connecting to ${config.host}...`);

        const cccCommand = args.length > 0 ? `ccc ${args.join(" ")}` : "ccc";
        const sshCommand = `cd "${config.remotePath}" && ${cccCommand}`;

        const sshProcess = spawn("ssh", ["-t", `${config.user}@${config.host}`, sshCommand], {
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

        // 4. Cleanup prompt on exit
        if (exitCode === 0) {
            const answer = await prompt("\nPause sync? [y/N]: ");
            if (answer.toLowerCase() === "y" || answer.toLowerCase() === "yes") {
                console.log("Pausing sync...");
                spawnSync("mutagen", ["sync", "pause", sessionName], {stdio: "inherit"});
                console.log("Sync paused. Run 'ccc remote' to resume.");
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
  Remote path [/current/path]: /home/john/projects/myapp
  Config saved.
  Creating sync session...
  Waiting for initial sync... done
  Connecting to my-desktop...
  [Now in claude on desktop]

Subsequent runs:
  $ ccc remote
  Using saved config: john@my-desktop:/home/john/projects/myapp
  Sync already running
  Connecting to my-desktop...

Pass arguments to claude:
  $ ccc remote my-desktop --continue
  $ ccc remote my-desktop --resume`);

    printSection("Requirements");

    console.log(`1. SSH access to remote host (key-based auth recommended)
2. ccc installed on remote host
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
        console.log(`  Remote path: ${config.remotePath}`);

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
