import { spawn, spawnSync } from "child_process";
import { randomBytes } from "crypto";
import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { hashPath, getProjectId, prompt, IMAGE_NAME, COMMON_IGNORE_DIRS, collectForwardedEnv, CONTAINER_ENV_KEY, CONTAINER_ENV_VALUE } from "../utils.js";
import { getContainerName } from "../docker.js";
import { legacyRemoteConfigDir, readCccConfig, updateCccConfig } from "../home-layout.js";
import { createSessionLock, removeSessionLock, withContainerLifecycleLock, withContainerLifecycleLockAsync } from "../session.js";
import { remoteContainerStartScript, remoteSessionReservationShell, remoteRefreshSessionShell, remoteReleaseSessionShell, remoteStopShell, shellEscapeArg } from "./remote-shell.js";
import type { RemoteConfig, RemoteEvent, RemoteFailureKind, RemoteSyncObservation } from "../domain/remote-services.js";
import type { RemoteServicesPorts } from "../ports/remote-services.js";

/** Native diagnostics and display text are opaque to application policy. */
export interface NativeEvidence {
    execution?: { status: number | null; stderr?: string | Buffer | null; error?: Error };
    syncStatus?: string;
}

export function getProjectHash(projectPath: string): string { return hashPath(resolve(projectPath)); }
export function getMutagenSessionName(projectPath: string): string { return `ccc-${getProjectId(projectPath)}`; }

function parseMutagenSyncStatus(output: string): string {
    const statusMatch = output.match(/Status:\s*(.+)/);
    return statusMatch ? statusMatch[1].trim() : "Unknown";
}

export function renderMutagenSyncStatus(observation: RemoteSyncObservation<NativeEvidence>): string | null {
    return observation.kind === "unavailable" ? null : observation.evidence.syncStatus ?? "Unknown";
}

function printStatus(label: string, ok: boolean, detail?: string): void {
    const icon = ok ? "[OK]" : "[--]";
    const detailStr = detail ? ` (${detail})` : "";
    console.log(`  ${icon} ${label}${detailStr}`);
}

function report(event: RemoteEvent<NativeEvidence>): void {
    switch (event.kind) {
        case "setup-start":
            console.log("\n=== CCC Remote Setup Guide ===\n");
            console.log("Checking required tools:\n");
            return;
        case "tool-status": printStatus(event.tool === "tailscale" ? "Tailscale" : "Mutagen", event.observation.installed, event.observation.version); return;
        case "tool-install-guide":
            if (event.tool === "tailscale") console.log(`
  Tailscale not found. Install it:
    macOS:   brew install tailscale
    Linux:   curl -fsSL https://tailscale.com/install.sh | sh
    Manual:  https://tailscale.com/download`);
            else console.log(`
  Mutagen not found. Install it:
    macOS:   brew install mutagen-io/mutagen/mutagen
    Linux:   Download from https://github.com/mutagen-io/mutagen/releases
    Manual:  https://mutagen.io/documentation/introduction/installation`);
            return;
        case "setup-tools-missing": console.log("\nPlease install missing tools and run 'ccc remote setup' again."); return;
        case "setup-usage":
            console.log("\n=== Usage ===\n");
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
            return;
        case "setup-architecture":
            console.log("\n=== Architecture ===\n");
            console.log(`Files sync directly from your Mac to a Docker container on the remote:
  1. Container started on remote (without project volume mount)
  2. Mutagen syncs: MacBook -> Docker container on remote
  3. Claude runs inside the container via docker exec

This avoids intermediate filesystem copies on the remote host.`);
            return;
        case "setup-requirements":
            console.log("\n=== Requirements ===\n");
            console.log(`1. SSH access to remote host (key-based auth recommended)
2. ccc installed on remote host (run 'ccc' once to build the image)
3. Docker running on remote host
4. Network connectivity (Tailscale recommended for remote access)

Config is stored per-project in ~/.ccc/config.json under "remote"`);
            return;
        case "status-start": console.log("\n=== CCC Remote Status ===\n"); return;
        case "status-tools": console.log("Tools:"); return;
        case "status-config": console.log("\nConfig:"); return;
        case "status-config-saved":
            console.log(`  Host: ${event.config.host}`);
            console.log(`  User: ${event.config.user}`);
            console.log(`  Container: ${event.containerName}`);
            return;
        case "host-status": printStatus("Host reachable", event.reachable); return;
        case "status-config-missing":
            console.log("  No config saved for this project.");
            console.log("  Run 'ccc remote <host>' to set up.");
            return;
        case "status-sync": console.log("\nSync:"); return;
        case "status-sync-active": printStatus(`Session '${event.sessionName}'`, true, event.observation.evidence.syncStatus); return;
        case "status-sync-missing":
            console.log("  No active sync session.");
            console.log(`  Session name would be: ${event.sessionName}`);
            return;
        case "status-sync-unavailable": console.log("  (mutagen not installed)"); return;
        case "status-end": console.log(""); return;
        case "mutagen-required": console.error("Mutagen is not installed. Run 'ccc remote setup' for installation guide."); return;
        case "config-invalid": console.error("Saved remote config contains invalid host or user. Please reconfigure with 'ccc remote <host>'."); return;
        case "saved-config": console.log(`Using saved config: ${event.config.user}@${event.config.host}`); return;
        case "host-invalid": console.error(`Invalid hostname: ${event.host}. Only alphanumeric, dots, hyphens, and underscores allowed.`); return;
        case "host-unreachable": console.error(`Host ${event.host} is not reachable. Check if it's online and accessible.`); return;
        case "user-invalid": console.error(`Invalid username: ${event.user}. Only alphanumeric, dots, hyphens, and underscores allowed.`); return;
        case "config-saved": console.log("Config saved."); return;
        case "config-required":
            console.error("No saved remote config found.");
            console.error("Usage: ccc remote <host>");
            console.error("       ccc remote           (after initial setup)");
            return;
        case "image-missing": console.log("Building ccc image on remote host..."); return;
        case "starting": console.log("Starting remote container..."); return;
        case "refresh-failed": console.error("Remote session lease refresh failed; container stop protection may expire."); return;
        case "connecting": console.log(`Connecting to ${event.host}...`); return;
        case "env-skipped": console.error(`Skipped ${event.count} host env var(s) to keep remote exec size bounded; use --env KEY=VALUE for required overrides.`); return;
        case "ssh-error": console.error(`SSH error: ${(event.error as { message: unknown }).message}`); return;
        case "stopping": console.log("Stopping container..."); return;
        case "peer-active": console.log("Remote container remains running: another CCC remote session is active."); return;
        case "pausing": console.log("Pausing sync..."); return;
        case "unexpected-error": console.error(`Error: ${event.error instanceof Error ? event.error.message : event.error}`); return;
        case "sync-replacing": console.log("Replacing stale sync session..."); return;
        case "sync-resuming": console.log("Resuming paused sync..."); return;
        case "sync-existing": console.log(`Sync already running (${event.observation.evidence.syncStatus})`); return;
        case "sync-creating":
            console.log("Creating sync session...");
            console.log(`  Local:  ${event.localPath}`);
            console.log(`  Remote: docker://${event.containerDisplayName}/project/${event.projectId} (via ${event.host})`);
            return;
        case "sync-waiting": process.stdout.write("Waiting for initial sync..."); return;
        case "sync-completed": console.log(" done"); return;
        case "sync-failed": console.log(` failed: ${event.observation.evidence.syncStatus}`); return;
        case "sync-poll": process.stdout.write("."); return;
        case "sync-timeout": console.log(" timeout"); return;
        case "sync-inactive": console.log("No active sync session for this project."); return;
        case "sync-terminating": console.log(`Terminating sync session '${event.sessionName}'...`); return;
        case "sync-terminated": console.log("Sync terminated."); return;
    }
    event satisfies never;
}

function fail(kind: RemoteFailureKind, evidence?: NativeEvidence): never {
    const result = evidence?.execution;
    switch (kind) {
        case "image-missing": throw new Error("ccc image not found on remote. Run 'ccc' on the remote host first to build the image.");
        case "config-unresolved": throw new Error("Remote configuration could not be resolved");
        case "start-failed": throw new Error(`Failed to start remote container: ${result?.stderr}`);
        case "missing-container-id": throw new Error("Failed to start remote container: stable container ID was not returned");
        case "project-prepare-failed": throw new Error(`Failed to prepare remote container project directory: ${result?.stderr || result?.error?.message || "unknown error"}`);
        case "sync-terminate-failed": throw new Error("Failed to terminate stale sync session");
        case "sync-resume-failed": throw new Error("Failed to resume sync session");
        case "sync-create-failed": throw new Error("Failed to create sync session");
        case "sync-missing": throw new Error("Sync session not found");
        case "sync-failed": throw new Error(`Sync failed: ${evidence?.syncStatus}`);
        case "sync-timeout": throw new Error("Sync timeout - initial sync did not complete");
        case "stop-failed": throw new Error(`Failed to stop remote container: ${result?.stderr || result?.status}`);
    }
}

export function createNativeRemoteServicesPorts(): RemoteServicesPorts<NativeEvidence> {
    return {
        resolveProjectPath: path => resolve(path), getProjectId: path => getProjectId(path),
        getProjectHash, getMutagenSessionName, getContainerName: (path, profile) => getContainerName(path, profile),
        hashRemoteIdentity: value => hashPath(value), newReservationToken: () => randomBytes(16).toString("hex"),
        observeTool: tool => {
            const result = spawnSync(tool, ["version"], { encoding: "utf-8" });
            return result.error || result.status !== 0 ? { installed: false } : { installed: true, version: (result.stdout ?? "").split("\n")[0].trim() };
        },
        isHostReachable: host => spawnSync("ping", ["-c", "1", "-W", "1", host], { encoding: "utf-8" }).status === 0,
        remoteImagePresent: config => {
            const result = spawnSync("ssh", [`${config.user}@${config.host}`, `docker images -q ${IMAGE_NAME}`], { encoding: "utf-8", timeout: 10000 });
            return Boolean(result.stdout?.trim());
        },
        reserveContainer: request => {
            const name = getContainerName(request.projectPath, request.profile);
            const command = remoteContainerStartScript(request.projectPath, request.profile);
            const body = remoteSessionReservationShell(name, request.token, request.leaseSeconds, command, true);
            const result = spawnSync("ssh", [`${request.config.user}@${request.config.host}`, body], { encoding: "utf-8", timeout: 60000 });
            if (result.status !== 0) return { kind: "failed", reason: "start-failed", evidence: { execution: result } };
            const match = (result.stdout ?? "").match(/^ccc-container-id=([a-fA-F0-9]{12,64})$/m);
            if (!match) return { kind: "failed", reason: "missing-container-id", evidence: { execution: result } };
            return { kind: "reserved", container: { name, id: match[1] } };
        },
        refreshReservation: request => {
            const body = remoteRefreshSessionShell(request.name, request.token, request.leaseSeconds, true, request.containerId);
            return spawnSync("ssh", [`${request.config.user}@${request.config.host}`, body], { encoding: "utf-8", timeout: 10000 }).status === 0;
        },
        releaseReservation: request => {
            const body = remoteReleaseSessionShell(request.name, request.token);
            spawnSync("ssh", [`${request.config.user}@${request.config.host}`, body], { encoding: "utf-8", timeout: 10000 });
        },
        stopReservedContainer: request => {
            const body = remoteStopShell(request.name, request.token, request.containerId);
            const result = spawnSync("ssh", [`${request.config.user}@${request.config.host}`, body], { encoding: "utf-8", timeout: 60000 });
            if (result.status === 42 || result.stdout?.includes("ccc-remote-sessions-active")) return { kind: "busy" };
            return result.status === 0 ? { kind: "stopped" } : { kind: "failed", evidence: { execution: result } };
        },
        prepareRemoteProject: request => {
            const command = `docker exec ${request.containerId} mkdir -p /project/${request.projectId}`;
            const result = spawnSync("ssh", [`${request.config.user}@${request.config.host}`, command], { encoding: "utf-8" });
            return result.error || result.status !== 0 ? { ok: false, evidence: { execution: result } } : { ok: true };
        },
        observeSync: (name, expectedContainerId, remainingMs) => {
            const timeout = remainingMs === undefined ? undefined : Math.floor(remainingMs);
            if (timeout !== undefined && !(timeout > 0)) return { kind: "unavailable" };
            const result = spawnSync("mutagen", ["sync", "list", name], { encoding: "utf-8", ...(timeout === undefined ? {} : { timeout }) });
            if (result.error || result.status !== 0) return { kind: "unavailable" };
            const output = result.stdout ?? "";
            const syncStatus = parseMutagenSyncStatus(output);
            const lowerStatus = syncStatus.toLowerCase();
            return {
                kind: "observed", endpointMatches: expectedContainerId !== undefined && output.includes(`docker://${expectedContainerId}/`),
                paused: lowerStatus.includes("paused"), watching: lowerStatus.includes("watching"),
                failed: lowerStatus.includes("error") || lowerStatus.includes("halted"), evidence: { syncStatus },
            };
        },
        startSyncDaemon: () => { spawnSync("mutagen", ["daemon", "start"], { stdio: "ignore" }); },
        terminateSync: name => { spawnSync("mutagen", ["sync", "terminate", name], { stdio: "inherit" }); },
        terminateStaleSync: name => {
            const result = spawnSync("mutagen", ["sync", "terminate", name], { stdio: "inherit" });
            return result.error || result.status !== 0 ? { ok: false, evidence: { execution: result } } : { ok: true };
        },
        resumeSync: name => {
            const result = spawnSync("mutagen", ["sync", "resume", name], { stdio: "inherit" });
            return result.error || result.status !== 0 ? { ok: false, evidence: { execution: result } } : { ok: true };
        },
        createSync: request => {
            const args = ["sync", "create", request.localPath, `${request.config.user}@${request.config.host}:docker://${request.containerId}/project/${request.projectId}`, "--name", request.name, "--ignore-vcs", ...COMMON_IGNORE_DIRS.map(dir => `--ignore=${dir}`)];
            const result = spawnSync("mutagen", args, { stdio: "inherit" });
            return result.status === 0 ? { ok: true } : { ok: false, evidence: { execution: result } };
        },
        pauseSync: name => { spawnSync("mutagen", ["sync", "pause", name], { stdio: "inherit" }); },
        readRemoteConfigs: () => {
            const remote = readCccConfig().remote;
            return remote && typeof remote === "object" && !Array.isArray(remote) ? remote as Record<string, unknown> : null;
        },
        prepareLegacyConfigReader: hash => {
            const file = join(legacyRemoteConfigDir(), `${hash}.json`);
            return { exists: () => existsSync(file), readConfig: () => JSON.parse(readFileSync(file, "utf-8")) as RemoteConfig };
        },
        saveRemoteConfig: (hash, config) => {
            updateCccConfig(settings => {
                const remote = settings.remote && typeof settings.remote === "object" && !Array.isArray(settings.remote) ? settings.remote as Record<string, unknown> : {};
                remote[hash] = config;
                settings.remote = remote;
            });
        },
        readUser: () => process.env.USER,
        prompt: request => request.kind === "user" ? prompt(`Remote user [${request.defaultUser}]: `) : prompt("\nStop container and pause sync? [y/N]: ", true),
        report, fail,
        createSessionLock: prefix => createSessionLock(prefix),
        removeSessionLock: file => { removeSessionLock(file); return undefined; },
        withLifecycleLock: (prefix, operation) => withContainerLifecycleLock(prefix, operation),
        withLifecycleLockAsync: (prefix, operation) => withContainerLifecycleLockAsync(prefix, operation),
        startHeartbeat: (callback, milliseconds) => {
            const timer = setInterval(callback, milliseconds);
            return { unref: () => { timer.unref(); return undefined; }, cancel: () => { clearInterval(timer); return undefined; } };
        },
        onceSignal: (signal, callback) => { process.once(signal, callback); return undefined; },
        removeSignalListener: (signal, callback) => { process.removeListener(signal, callback); return undefined; },
        resignalSelf: signal => process.kill(process.pid, signal), exit: code => process.exit(code),
        collectCurrentForwardedEnv: () => collectForwardedEnv(process.env),
        startInteractiveSession: request => {
            const claudeArgs = request.arguments.length > 0 ? request.arguments.map(shellEscapeArg).join(" ") : "--dangerously-skip-permissions";
            const envFlags = [`-e ${shellEscapeArg(`${CONTAINER_ENV_KEY}=${CONTAINER_ENV_VALUE}`)}`, ...request.environment.map(([key, value]) => "-e " + shellEscapeArg(key + "=" + value))];
            const program = `cd ${shellEscapeArg(`/project/${request.projectId}`)} && mise trust . 2>/dev/null; mise install -y || true; exec claude ${claudeArgs}`;
            const encodedProgram = Buffer.from(program, "utf8").toString("base64");
            const decoder = `printf %s ${shellEscapeArg(encodedProgram)} | base64 -d | sh`;
            const command = `docker exec ${envFlags.join(" ")} -it ${request.containerId} sh -c ${shellEscapeArg(decoder)}`;
            const child = spawn("ssh", ["-t", `${request.config.user}@${request.config.host}`, command], { stdio: "inherit" });
            return {
                onClose: callback => { child.on("close", callback); return undefined; },
                onError: callback => { child.on("error", callback); return undefined; },
                kill: signal => child.kill(signal),
            };
        },
        now: () => performance.now(), sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    };
}
