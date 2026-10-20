import { spawn, spawnSync } from "child_process";
import { randomBytes } from "crypto";
import { existsSync, readFileSync } from "fs";
import { isAbsolute, join, resolve, win32 } from "path";
import { createInterface } from "readline";
import { hashPath, getProjectId, IMAGE_NAME, COMMON_IGNORE_DIRS, collectForwardedEnv, CONTAINER_ENV_KEY, CONTAINER_ENV_VALUE } from "../utils.js";
import { getContainerName } from "../docker.js";
import { legacyRemoteConfigDir, readCccConfig, updateCccConfig } from "../home-layout.js";
import { createSessionLock, removeSessionLock, removeSessionLockInHeldLifecycleLock, withContainerLifecycleLock, withContainerLifecycleLockAsync } from "../session.js";
import { remoteContainerStartScript, remoteSessionReservationShell, remoteRefreshSessionShell, remoteReleaseSessionShell, remoteStopShell, shellEscapeArg } from "./remote-shell.js";
import type { RemoteConfig, RemoteEvent, RemoteExecutionOutcome, RemoteFailureKind, RemoteObservedSync, RemotePrompt, RemoteSyncAuthority, RemoteSyncBinding, RemoteSyncInventory, RemoteTerminateOutcome } from "../domain/remote-services.js";
import type { RemoteServicesPorts } from "../ports/remote-services.js";
import { captureInteractiveTerminal } from "./interactive-terminal.js";

/** Native diagnostics and display text are opaque to application policy. */
export interface NativeEvidence {
    execution?: { status: number | null; stderr?: string | Buffer | null; error?: Error };
    syncStatus?: string;
}

export function getProjectHash(projectPath: string): string { return hashPath(resolve(projectPath)); }
export function getMutagenSessionName(projectPath: string): string { return `ccc-${getProjectId(projectPath)}`; }

function validSyncIdentifier(identifier: string): boolean {
    return /^[a-z]{4}_[0-9a-zA-Z]{43}$/.test(identifier) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(identifier);
}

function validSyncName(name: string): boolean {
    return name === "" || name !== "defaults" && /^\p{L}[\p{L}\p{N}-]*$/u.test(name) &&
        !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(name);
}

interface NativeSyncEndpoint {
    protocol: string;
    user?: string;
    host?: string;
    port?: number;
    path: string;
    environment?: Record<string, string>;
    parameters?: Record<string, string>;
}

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nativeSyncEndpoint(value: unknown): NativeSyncEndpoint | null {
    if (!record(value) || !["local", "ssh", "docker"].includes(value.protocol as string) || typeof value.path !== "string" || !value.path) return null;
    if (value.user !== undefined && typeof value.user !== "string" || value.host !== undefined && typeof value.host !== "string") return null;
    if (value.port !== undefined && (typeof value.port !== "number" || !Number.isInteger(value.port) || value.port < 0 || value.port > 65535)) return null;
    for (const field of ["environment", "parameters"]) {
        const map = value[field];
        if (map !== undefined && (!record(map) || Object.values(map).some(entry => typeof entry !== "string"))) return null;
    }
    const endpoint = value as unknown as NativeSyncEndpoint;
    const hasEnvironment = Object.keys(endpoint.environment ?? {}).length > 0;
    const hasParameters = Object.keys(endpoint.parameters ?? {}).length > 0;
    if (endpoint.protocol === "local" && (endpoint.user || endpoint.host || endpoint.port || hasEnvironment || hasParameters ||
        !isAbsolute(endpoint.path) || process.platform === "win32" && win32.parse(endpoint.path).root.length <= 1)) return null;
    if (endpoint.protocol === "ssh" && (!endpoint.host || hasEnvironment)) return null;
    if (endpoint.protocol === "docker" && (!endpoint.host || endpoint.port ||
        !(endpoint.path.startsWith("/") || endpoint.path.startsWith("~") || /^[a-zA-Z]:[\\/]/.test(endpoint.path)))) return null;
    return endpoint;
}

function qualifiedSyncBinding(alpha: NativeSyncEndpoint, beta: NativeSyncEndpoint): RemoteSyncBinding | null {
    if (alpha.protocol !== "local" || beta.protocol !== "ssh" || !beta.user || !beta.host || beta.port || Object.keys(beta.parameters ?? {}).length > 0) return null;
    const target = /^docker:\/\/([a-fA-F0-9]{12,64})\/project\/([^/]+)$/.exec(beta.path);
    if (!target) return null;
    return { localPath: alpha.path, user: beta.user, host: beta.host, containerId: target[1], projectId: target[2] };
}

function parseSyncInventory(output: string, evidence: NativeEvidence): RemoteSyncInventory<NativeEvidence> {
    let data: unknown;
    try { data = JSON.parse(output); } catch { return { kind: "unknown", evidence }; }
    if (!Array.isArray(data)) return { kind: "unknown", evidence };
    const sessions: RemoteObservedSync<NativeEvidence>[] = [];
    const identifiers = new Set<string>();
    const statusDescriptions = new Map([
        ["disconnected", "Disconnected"],
        ["halted-on-root-emptied", "Halted due to one-sided root emptying"],
        ["halted-on-root-deletion", "Halted due to root deletion"],
        ["halted-on-root-type-change", "Halted due to root type change"],
        ["connecting-alpha", "Connecting to alpha"],
        ["connecting-beta", "Connecting to beta"],
        ["watching", "Watching for changes"],
        ["scanning", "Scanning files"],
        ["waiting-for-rescan", "Waiting 5 seconds for rescan"],
        ["reconciling", "Reconciling changes"],
        ["staging-alpha", "Staging files on alpha"],
        ["staging-beta", "Staging files on beta"],
        ["transitioning", "Applying changes"],
        ["saving", "Saving archive"],
        ["unknown", "Unknown"],
    ]);
    for (const value of data) {
        if (!record(value) || typeof value.identifier !== "string" || !validSyncIdentifier(value.identifier) || identifiers.has(value.identifier) ||
            value.name !== undefined && (typeof value.name !== "string" || !validSyncName(value.name)) || typeof value.paused !== "boolean" ||
            typeof value.status !== "string" || !statusDescriptions.has(value.status) || value.lastError !== undefined && typeof value.lastError !== "string") {
            return { kind: "unknown", evidence };
        }
        const alpha = nativeSyncEndpoint(value.alpha);
        const beta = nativeSyncEndpoint(value.beta);
        if (!alpha || !beta) return { kind: "unknown", evidence };
        identifiers.add(value.identifier);
        const syncStatus = value.paused ? "Paused" : statusDescriptions.get(value.status);
        sessions.push({ kind: "observed", identifier: value.identifier, name: value.name ?? "", binding: qualifiedSyncBinding(alpha, beta),
            paused: value.paused, watching: value.status === "watching", failed: value.status.startsWith("halted-") || Boolean(value.lastError), evidence: { ...evidence, syncStatus } });
    }
    return { kind: "known", sessions, evidence };
}

/** Legacy display helper has no mutation authority. */
export function renderMutagenSyncStatus(inventory: RemoteSyncInventory<NativeEvidence>, name: string): string | null {
    if (inventory.kind === "unknown") return null;
    const matches = inventory.sessions.filter(session => session.name === name);
    return matches.length === 1 ? matches[0].evidence.syncStatus ?? "Unknown" : null;
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
        case "status-sync-unknown": console.log("  Sync state could not be established."); return;
        case "status-sync-conflict": console.log("  Conflicting or unqualified sync sessions require manual inspection."); return;
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

function failureError(kind: RemoteFailureKind, evidence?: NativeEvidence): Error {
    const result = evidence?.execution;
    switch (kind) {
        case "image-missing": return new Error("ccc image not found on remote. Run 'ccc' on the remote host first to build the image.");
        case "config-unresolved": return new Error("Remote configuration could not be resolved");
        case "config-invalid": return new Error("Saved remote configuration contains an invalid host or user");
        case "start-failed": return new Error(`Failed to start remote container: ${result?.stderr}`);
        case "missing-container-id": return new Error("Failed to start remote container: stable container ID was not returned");
        case "project-prepare-failed": return new Error(`Failed to prepare remote container project directory: ${result?.stderr || result?.error?.message || "unknown error"}`);
        case "sync-terminate-failed": return new Error("Failed to terminate sync session");
        case "sync-resume-failed": return new Error("Failed to resume sync session");
        case "sync-create-failed": return new Error("Failed to create sync session");
        case "sync-missing": return new Error("Sync session not found");
        case "sync-unknown": return new Error("Sync state could not be established");
        case "sync-conflict": return new Error("Conflicting or unqualified sync sessions require manual inspection");
        case "sync-pause-failed": return new Error("Failed to pause sync session");
        case "sync-failed": return new Error(`Sync failed: ${evidence?.syncStatus}`);
        case "sync-timeout": return new Error("Sync timeout - initial sync did not complete");
        case "stop-failed": return new Error(`Failed to stop remote container: ${result?.stderr || result?.status}`);
    }
}

/** Process status and native errors are projected only after application settlement. */
export function projectRemoteExecutionOutcome(outcome: RemoteExecutionOutcome<NativeEvidence>): void {
    if (outcome.kind === "failed") report({ kind: "unexpected-error", error: failureError(outcome.reason, outcome.evidence) });
    if (outcome.kind === "fault") report({ kind: "unexpected-error", error: outcome.error });
    for (const failure of outcome.cleanupFailures) {
        const error = failure.kind === "cleanup-fault" ? failure.error :
            new Error(`Failed to release remote session reservation: ${failure.evidence.execution?.stderr || failure.evidence.execution?.error?.message || failure.evidence.execution?.status}`);
        report({ kind: "unexpected-error", error });
    }
    if (outcome.kind === "cancelled") { process.kill(process.pid, outcome.signal); return; }
    const code = outcome.kind === "completed" ? outcome.exitCode : 1;
    process.exit(code === 0 && outcome.cleanupFailures.length > 0 ? 1 : code);
}

export function projectRemoteTerminateOutcome(outcome: RemoteTerminateOutcome<NativeEvidence>): void {
    if (outcome.kind === "failed") throw failureError(outcome.reason, outcome.evidence);
    if (outcome.kind === "fault") throw outcome.error;
}

function nativePrompt(request: Parameters<RemoteServicesPorts["prompt"]>[0]): RemotePrompt {
    let reader: ReturnType<typeof createInterface> | null = null, settled = false;
    let finish: (answer: string) => void = () => {};
    const result = new Promise<string>((resolve, reject) => {
        reader = createInterface({ input: process.stdin, output: process.stdout });
        const owned = reader;
        finish = answer => { if (!settled) { settled = true; resolve(answer); } };
        owned.on("close", () => finish(""));
        const question = request.kind === "user" ? `Remote user [${request.defaultUser}]: ` : "\nStop container and pause sync? [y/N]: ";
        try {
            owned.question(question, answer => {
                if (settled) return;
                const trimmed = answer.trim();
                finish(request.kind === "cleanup" ? trimmed.toLowerCase() : trimmed);
                owned.close();
            });
        } catch (error) {
            settled = true;
            try { owned.close(); } finally { reject(error); }
        }
    });
    return { result, cancel: () => {
        if (!settled) { finish(""); reader?.close(); }
        return undefined;
    } };
}

export function createNativeRemoteServicesPorts(): RemoteServicesPorts<NativeEvidence> {
    const mutagenEnvironment = { ...process.env };
    const mutagenCwd = process.cwd();
    const mutagenOptions = { env: mutagenEnvironment, cwd: mutagenCwd };
    const controlSync = (operation: "resume" | "terminate" | "pause", identifier: string) => {
        if (!validSyncIdentifier(identifier)) return { ok: false as const, evidence: { syncStatus: "Invalid sync identifier" } };
        const result = spawnSync("mutagen", ["sync", operation, identifier], { ...mutagenOptions, stdio: "inherit" });
        return result.error || result.status !== 0 ? { ok: false as const, evidence: { execution: result } } : { ok: true as const };
    };
    return {
        resolveProjectPath: path => resolve(mutagenCwd, path), getProjectId: path => getProjectId(path),
        getProjectHash, getMutagenSessionName, getContainerName: (path, profile) => getContainerName(path, profile),
        getScopedMutagenSessionName: (authority: RemoteSyncAuthority) => `ccc-${authority.projectId}-${hashPath(`${authority.user}@${authority.host}`)}`,
        hashRemoteIdentity: value => hashPath(value), newReservationToken: () => randomBytes(16).toString("hex"),
        observeTool: tool => {
            const result = spawnSync(tool, ["version"], { encoding: "utf-8", ...(tool === "mutagen" ? mutagenOptions : {}) });
            return result.error || result.status !== 0 ? { installed: false } : { installed: true, version: (result.stdout ?? "").split("\n")[0].trim() };
        },
        isHostReachable: host => spawnSync("ping", ["-c", "1", "-W", "1", host], { encoding: "utf-8" }).status === 0,
        remoteImagePresent: config => {
            const result = spawnSync("ssh", [`${config.user}@${config.host}`, `docker images -q ${IMAGE_NAME}`], { encoding: "utf-8", timeout: 10000 });
            return Boolean(result.stdout?.trim());
        },
        reserveContainer: request => {
            const name = getContainerName(request.projectPath, request.profile);
            const command = remoteContainerStartScript(request.projectPath, request.profile, true);
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
            const result = spawnSync("ssh", [`${request.config.user}@${request.config.host}`, body], { encoding: "utf-8", timeout: 10000 });
            return result.error || result.status !== 0 ? { ok: false, evidence: { execution: result } } : { ok: true };
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
        observeSyncInventory: remainingMs => {
            const timeout = remainingMs === undefined ? 30000 : Math.min(30000, Math.floor(remainingMs));
            if (!(timeout > 0)) return { kind: "unknown", evidence: {} };
            const result = spawnSync("mutagen", ["sync", "list", "--template", "{{json .}}"], { ...mutagenOptions, encoding: "utf-8", timeout, killSignal: "SIGKILL" });
            const evidence = { execution: result };
            if (result.error || result.status !== 0) return { kind: "unknown", evidence };
            return parseSyncInventory(result.stdout ?? "", evidence);
        },
        startSyncDaemon: () => { spawnSync("mutagen", ["daemon", "start"], { ...mutagenOptions, stdio: "ignore" }); },
        terminateSync: identifier => controlSync("terminate", identifier),
        resumeSync: identifier => controlSync("resume", identifier),
        createSync: request => {
            const args = ["sync", "create", request.localPath, `${request.config.user}@${request.config.host}:docker://${request.containerId}/project/${request.projectId}`, "--name", request.name, "--ignore-vcs", ...COMMON_IGNORE_DIRS.map(dir => `--ignore=${dir}`)];
            const result = spawnSync("mutagen", args, { ...mutagenOptions, stdio: "inherit" });
            return result.error || result.status !== 0 ? { ok: false, evidence: { execution: result } } : { ok: true };
        },
        pauseSync: identifier => controlSync("pause", identifier),
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
        prompt: nativePrompt,
        report,
        createSessionLock: prefix => createSessionLock(prefix),
        removeSessionLock: file => { removeSessionLock(file); return undefined; },
        removeSessionLockInHeldLifecycleLock: file => { removeSessionLockInHeldLifecycleLock(file); return undefined; },
        withLifecycleLock: (prefix, operation) => withContainerLifecycleLock(prefix, operation),
        withLifecycleLockAsync: (prefix, operation) => withContainerLifecycleLockAsync(prefix, operation),
        startHeartbeat: (callback, milliseconds) => {
            const timer = setInterval(callback, milliseconds);
            return { unref: () => { timer.unref(); return undefined; }, cancel: () => { clearInterval(timer); return undefined; } };
        },
        onSignal: (signal, callback) => { process.on(signal, callback); return undefined; },
        removeSignalListener: (signal, callback) => { process.removeListener(signal, callback); return undefined; },
        collectCurrentForwardedEnv: () => collectForwardedEnv(process.env),
        startInteractiveSession: request => {
            const claudeArgs = request.arguments.length > 0 ? request.arguments.map(shellEscapeArg).join(" ") : "--dangerously-skip-permissions";
            const envFlags = [`-e ${shellEscapeArg(`${CONTAINER_ENV_KEY}=${CONTAINER_ENV_VALUE}`)}`, ...request.environment.map(([key, value]) => "-e " + shellEscapeArg(key + "=" + value))];
            const program = `cd ${shellEscapeArg(`/project/${request.projectId}`)} && mise trust . 2>/dev/null; mise install -y || true; exec claude ${claudeArgs}`;
            const encodedProgram = Buffer.from(program, "utf8").toString("base64");
            const decoder = `printf %s ${shellEscapeArg(encodedProgram)} | base64 -d | sh`;
            const command = `docker exec ${envFlags.join(" ")} -it ${request.containerId} sh -c ${shellEscapeArg(decoder)}`;
            const restoreTerminal = captureInteractiveTerminal();
            let child: ReturnType<typeof spawn>;
            try { child = spawn("ssh", ["-t", `${request.config.user}@${request.config.host}`, command], { stdio: "inherit" }); }
            catch (error) { restoreTerminal(); throw error; }
            return {
                onClose: callback => { child.on("close", (code: number | null) => { restoreTerminal(); callback(code); }); return undefined; },
                onError: callback => { child.on("error", (error: Error) => { restoreTerminal(); callback(error); }); return undefined; },
                kill: signal => { try { return child.kill(signal); } finally { restoreTerminal(); } },
            };
        },
        now: () => performance.now(), sleep: milliseconds => {
            let settled = false;
            let finish: () => void = () => {};
            const completion = new Promise<void>(resolve => { finish = resolve; });
            const timer = setTimeout(() => { settled = true; finish(); }, milliseconds);
            return { completion, cancel: () => {
                if (!settled) { settled = true; clearTimeout(timer); finish(); }
                return undefined;
            } };
        },
    };
}
