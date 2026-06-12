import { createHash, randomBytes } from "crypto";
import { spawn } from "child_process";
import { accessSync, chmodSync, closeSync, constants as fsConstants, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { ownerId } from "./context.mjs";

const HOST_CANDIDATES = [
    "host.docker.internal",
    "host.containers.internal",
    "gateway.docker.internal",
    "172.17.0.1",
    "10.0.2.2",
];
const MAX_PROBE_CANDIDATES = 8;
const MAX_PROBE_TIMEOUT_MS = 2000;
const MAX_RPC_BODY_BYTES = 64 * 1024;
const BROKER_NAME = "ccc-device-broker";
const PUBLIC_BROKER_RPC_METHODS = new Set(["broker.status", "broker.inventory", "broker.echo"]);
const MAX_LAUNCH_TIMEOUT_MS = 5000;
const ownedBrokerChildren = new Map();
let cleanupRegistered = false;
let exitingFromSignal = false;

export function brokerStateRoot() {
    return join(homedir(), ".ccc/devices");
}

function brokerRuntimeFile() {
    return join(brokerStateRoot(), "broker", "runtime.json");
}

function brokerLogsRoot() {
    return join(brokerStateRoot(), "broker", "logs");
}

function readBrokerRuntime() {
    try {
        if (!existsSync(brokerRuntimeFile())) return null;
        const parsed = JSON.parse(readFileSync(brokerRuntimeFile(), "utf8"));
        return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
        return null;
    }
}

function writeBrokerRuntime(runtime) {
    mkdirSync(join(brokerStateRoot(), "broker"), { recursive: true });
    writeFileSync(brokerRuntimeFile(), JSON.stringify(runtime, null, 2), { mode: 0o600 });
}

function removeBrokerRuntime() {
    try {
        unlinkSync(brokerRuntimeFile());
    } catch {
        // Stale metadata is best-effort cleanup.
    }
}

function pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function executableExists(executable) {
    if (executable.includes("/")) {
        try {
            accessSync(executable, fsConstants.X_OK);
            return true;
        } catch {
            return false;
        }
    }
    for (const pathEntry of (process.env.PATH || "").split(":").filter(Boolean)) {
        try {
            accessSync(join(pathEntry, executable), fsConstants.X_OK);
            return true;
        } catch {
            // Continue PATH lookup without invoking a shell.
        }
    }
    return false;
}

function normalizeLaunchOptions(options = {}) {
    const probeOptions = normalizeProbeOptions({ ...options, probe: true });
    const launchTimeoutMs = Number.isFinite(options.launchTimeoutMs)
        ? Math.min(MAX_LAUNCH_TIMEOUT_MS, Math.max(1, Number(options.launchTimeoutMs)))
        : 2500;
    const host = typeof options.launchHost === "string" && options.launchHost
        ? options.launchHost
        : (probeOptions.hostCandidates.includes("127.0.0.1") ? "127.0.0.1" : probeOptions.hostCandidates[0] || "127.0.0.1");
    return {
        ...probeOptions,
        host,
        port: probeOptions.port,
        launchTimeoutMs,
        command: "ccc",
        args: ["devices", "broker", "serve", "--host", host, "--port", String(probeOptions.port)],
    };
}

function normalizeProbeOptions(options = {}) {
    const hostCandidates = Array.isArray(options.hostCandidates) && options.hostCandidates.length > 0
        ? options.hostCandidates.map(String).slice(0, MAX_PROBE_CANDIDATES)
        : HOST_CANDIDATES;
    const port = Number.isInteger(options.port) ? Number(options.port) : 17373;
    const timeoutMs = Number.isFinite(options.timeoutMs)
        ? Math.min(MAX_PROBE_TIMEOUT_MS, Math.max(1, Number(options.timeoutMs)))
        : 750;
    return { probe: options.probe === true, hostCandidates, port, timeoutMs };
}

async function probeBrokerHealth({ hostCandidates, port, timeoutMs }) {
    const attempts = [];
    for (const host of hostCandidates) {
        const endpoint = `http://${host}:${port}/health`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const startedAt = Date.now();
        try {
            const response = await fetch(endpoint, { signal: controller.signal });
            const text = await response.text();
            let body = null;
            try {
                body = text ? JSON.parse(text) : null;
            } catch {
                body = { raw: text };
            }
            const attempt = {
                host,
                port,
                endpoint,
                ok: response.ok,
                status: response.status,
                durationMs: Date.now() - startedAt,
                body,
            };
            attempts.push(attempt);
            if (response.ok) return { requested: true, available: true, selected: attempt, attempts };
        } catch (error) {
            attempts.push({
                host,
                port,
                endpoint,
                ok: false,
                status: null,
                durationMs: Date.now() - startedAt,
                error: error?.name === "AbortError" ? "timeout" : error?.message || String(error),
            });
        } finally {
            clearTimeout(timer);
        }
    }
    return { requested: true, available: false, selected: null, attempts };
}

async function waitForBrokerHealth({ host, port, timeoutMs }) {
    const deadline = Date.now() + timeoutMs;
    const attempts = [];
    while (Date.now() <= deadline) {
        const remaining = Math.max(1, Math.min(250, deadline - Date.now()));
        const probe = await probeBrokerHealth({ hostCandidates: [host], port, timeoutMs: remaining });
        attempts.push(...probe.attempts);
        if (probe.available) return { ...probe, attempts };
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return { requested: true, available: false, selected: null, attempts };
}

function cleanupOwnedBrokerChildren() {
    for (const [pid, child] of ownedBrokerChildren.entries()) {
        try {
            process.kill(pid, "SIGTERM");
        } catch {
            // Already gone.
        }
        try {
            child.kill?.("SIGTERM");
        } catch {
            // Already gone.
        }
        try {
            process.kill(pid, "SIGKILL");
        } catch {
            // Already gone.
        }
        try {
            child.kill?.("SIGKILL");
        } catch {
            // Already gone.
        }
        ownedBrokerChildren.delete(pid);
    }
    const runtime = readBrokerRuntime();
    if (runtime?.managedBy === "device-lab-mcp" && runtime.ownerId === ownerId()) {
        removeBrokerRuntime();
    }
}

function registerBrokerCleanup() {
    if (cleanupRegistered) return;
    cleanupRegistered = true;
    process.once("exit", cleanupOwnedBrokerChildren);
    for (const signal of ["SIGINT", "SIGTERM"]) {
        process.once(signal, () => {
            cleanupOwnedBrokerChildren();
            if (!exitingFromSignal) {
                exitingFromSignal = true;
                process.kill(process.pid, signal);
            }
        });
    }
}

async function waitForProcessExit(pid, timeoutMs = 1500) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
        if (!pidAlive(pid)) return true;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return !pidAlive(pid);
}

async function ensureBroker(options = {}) {
    const owner = ownerId();
    const launch = normalizeLaunchOptions(options);
    const before = await probeBrokerHealth(launch);
    if (before.available) {
        return {
            ok: true,
            ownerId: owner,
            launched: false,
            reused: true,
            runtime: readBrokerRuntime(),
            host: before.selected.host,
            port: before.selected.port,
            attempts: before.attempts,
        };
    }

    const existing = readBrokerRuntime();
    const stale = [];
    if (existing) {
        if (existing.ownerId !== owner) {
            return {
                ok: false,
                ownerId: owner,
                error: "runtime-owned-by-another-owner",
                runtime: existing,
                attempts: [...before.attempts, { reason: "runtime-owned-by-another-owner", runtime: existing }],
            };
        } else if (!pidAlive(existing.pid)) {
            stale.push({ reason: "runtime-pid-not-alive", runtime: existing });
            removeBrokerRuntime();
        } else {
            const existingProbe = await probeBrokerHealth({
                hostCandidates: [existing.host || launch.host],
                port: existing.port || launch.port,
                timeoutMs: launch.timeoutMs,
            });
            if (existingProbe.available) {
                return {
                    ok: true,
                    ownerId: owner,
                    launched: false,
                    reused: true,
                    runtime: existing,
                    host: existingProbe.selected.host,
                    port: existingProbe.selected.port,
                    attempts: [...before.attempts, ...existingProbe.attempts],
                };
            }
            stale.push({ reason: "runtime-health-check-failed", runtime: existing, attempts: existingProbe.attempts });
            removeBrokerRuntime();
        }
    }

    mkdirSync(brokerLogsRoot(), { recursive: true });
    const startedAt = new Date().toISOString();
    const logPath = join(brokerLogsRoot(), `broker-${owner}-${Date.now()}.log`);
    let logFd = null;
    try {
        if (!executableExists(launch.command)) {
            return {
                ok: false,
                ownerId: owner,
                error: "broker-launch-failed",
                detail: "executable-not-found",
                command: launch.command,
                args: launch.args,
                logPath,
                attempts: [...before.attempts, ...stale],
            };
        }
        logFd = openSync(logPath, "a", 0o600);
        const child = spawn(launch.command, launch.args, {
            stdio: ["ignore", logFd, logFd],
            detached: false,
        });
        child.once("exit", () => {
            ownedBrokerChildren.delete(child.pid);
        });
        child.once("error", () => {
            ownedBrokerChildren.delete(child.pid);
        });
        if (child.pid) ownedBrokerChildren.set(child.pid, child);
        registerBrokerCleanup();
        const runtime = {
            name: BROKER_NAME,
            ownerId: owner,
            pid: child.pid || null,
            host: launch.host,
            port: launch.port,
            command: launch.command,
            args: launch.args,
            logPath,
            startedAt,
            managedBy: "device-lab-mcp",
        };
        writeBrokerRuntime(runtime);
        const ready = await waitForBrokerHealth({ host: launch.host, port: launch.port, timeoutMs: launch.launchTimeoutMs });
        if (ready.available) {
            return {
                ok: true,
                ownerId: owner,
                launched: true,
                reused: false,
                runtime,
                host: launch.host,
                port: launch.port,
                attempts: [...before.attempts, ...stale, ...ready.attempts],
            };
        }
        try {
            if (child.pid) process.kill(child.pid, "SIGTERM");
        } catch {
            // Already gone.
        }
        if (child.pid) ownedBrokerChildren.delete(child.pid);
        removeBrokerRuntime();
        return {
            ok: false,
            ownerId: owner,
            error: "broker-launch-health-timeout",
            runtime,
            attempts: [...before.attempts, ...stale, ...ready.attempts],
        };
    } catch (error) {
        removeBrokerRuntime();
        return {
            ok: false,
            ownerId: owner,
            error: "broker-launch-failed",
            detail: error?.message || String(error),
            command: launch.command,
            args: launch.args,
            logPath,
            attempts: [...before.attempts, ...stale],
        };
    } finally {
        if (logFd !== null) {
            try {
                closeSync(logFd);
            } catch {
                // Ignore log close failures.
            }
        }
    }
}

export async function brokerShutdown(options = {}) {
    const owner = ownerId();
    const runtime = readBrokerRuntime();
    if (!runtime) return { ok: true, ownerId: owner, stopped: false, reason: "no-runtime" };
    if (runtime.ownerId !== owner) {
        return { ok: false, ownerId: owner, error: "runtime-owned-by-another-owner", runtime };
    }
    if (runtime.managedBy !== "device-lab-mcp") {
        return { ok: false, ownerId: owner, error: "runtime-not-managed-by-device-lab-mcp", runtime };
    }
    let signaled = false;
    if (pidAlive(runtime.pid)) {
        try {
            process.kill(runtime.pid, options.force === true ? "SIGKILL" : "SIGTERM");
            signaled = true;
        } catch (error) {
            return { ok: false, ownerId: owner, error: "broker-shutdown-failed", detail: error?.message || String(error), runtime };
        }
        const exited = await waitForProcessExit(runtime.pid, options.force === true ? 500 : 1500);
        if (!exited) {
            return { ok: false, ownerId: owner, error: "broker-shutdown-timeout", stopped: false, runtime };
        }
    }
    ownedBrokerChildren.delete(runtime.pid);
    removeBrokerRuntime();
    return { ok: true, ownerId: owner, stopped: signaled, runtime };
}

function brokerAuthSecretFile(owner) {
    if (!/^[a-f0-9]{16}$/.test(owner)) throw new Error("invalid-owner-id");
    return join(brokerStateRoot(), "broker", "auth", `${owner}.json`);
}

function ownerSecret(owner) {
    const file = brokerAuthSecretFile(owner);
    try {
        if (existsSync(file)) {
            const parsed = JSON.parse(readFileSync(file, "utf8"));
            if (typeof parsed?.secret === "string" && /^[a-f0-9]{64}$/.test(parsed.secret)) {
                try { chmodSync(file, 0o600); } catch { /* best effort on non-POSIX filesystems */ }
                return parsed.secret;
            }
        }
    } catch {
        // Replace unreadable/invalid auth metadata with a fresh owner secret.
    }
    const secret = randomBytes(32).toString("hex");
    mkdirSync(join(brokerStateRoot(), "broker", "auth"), { recursive: true });
    writeFileSync(file, JSON.stringify({
        ownerId: owner,
        secret,
        createdAt: new Date().toISOString(),
        version: 1,
    }, null, 2), { mode: 0o600 });
    try { chmodSync(file, 0o600); } catch { /* best effort on non-POSIX filesystems */ }
    return secret;
}

function ownerToken(owner) {
    return createHash("sha256").update(`${BROKER_NAME}:owner:${owner}:secret:${ownerSecret(owner)}`).digest("hex");
}

function summarizeBody(body) {
    if (body === undefined) return null;
    if (body === null) return null;
    if (typeof body === "object") return body;
    return { raw: String(body) };
}

export async function brokerRpc(options = {}) {
    return brokerRpcRequest({ ...options, publicTool: true });
}

async function brokerRpcRequest(options = {}) {
    const owner = ownerId();
    let probeOptions = normalizeProbeOptions({ ...options, probe: true });
    const method = typeof options.method === "string" ? options.method : "";
    if (!method) {
        return {
            ok: false,
            ownerId: owner,
            error: "missing-method",
            attempts: [],
        };
    }
    if (options.publicTool === true && !PUBLIC_BROKER_RPC_METHODS.has(method)) {
        return {
            ok: false,
            ownerId: owner,
            method,
            error: "unsupported-public-broker-rpc-method",
            allowed: [...PUBLIC_BROKER_RPC_METHODS],
            attempts: [],
        };
    }
    const requestBody = JSON.stringify({
        ownerId: owner,
        method,
        params: options.params ?? {},
    });
    if (Buffer.byteLength(requestBody) > MAX_RPC_BODY_BYTES) {
        return {
            ok: false,
            ownerId: owner,
            method,
            error: "request-too-large",
            maxBytes: MAX_RPC_BODY_BYTES,
            attempts: [],
        };
    }

    let launch = null;
    if (options.autolaunch === true) {
        launch = await ensureBroker(options);
        if (!launch.ok) {
            return {
                ok: false,
                ownerId: owner,
                method,
                selected: null,
                error: launch.error,
                launch,
                attempts: launch.attempts || [],
            };
        }
        probeOptions = { ...probeOptions, hostCandidates: [launch.host], port: launch.port };
    }

    const attempts = [];
    for (const host of probeOptions.hostCandidates) {
        const endpoint = `http://${host}:${probeOptions.port}/v1/owners/${encodeURIComponent(owner)}/rpc`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), probeOptions.timeoutMs);
        const startedAt = Date.now();
        try {
            const response = await fetch(endpoint, {
                method: "POST",
                signal: controller.signal,
                headers: {
                    "content-type": "application/json",
                    "x-ccc-device-token": ownerToken(owner),
                },
                body: requestBody,
            });
            const text = await response.text();
            let body = null;
            try {
                body = text ? JSON.parse(text) : null;
            } catch {
                body = { raw: text };
            }
            const attempt = {
                host,
                port: probeOptions.port,
                endpoint,
                ok: response.ok,
                status: response.status,
                durationMs: Date.now() - startedAt,
                body: summarizeBody(body),
            };
            attempts.push(attempt);
            if (response.ok) {
                return {
                    ok: true,
                    ownerId: owner,
                    method,
                    selected: attempt,
                    result: body?.result ?? body,
                    launch,
                    attempts,
                };
            }
            return {
                ok: false,
                ownerId: owner,
                method,
                selected: attempt,
                error: body?.error || "broker-rpc-failed",
                status: response.status,
                result: body?.result ?? null,
                body: summarizeBody(body),
                launch,
                attempts,
            };
        } catch (error) {
            attempts.push({
                host,
                port: probeOptions.port,
                endpoint,
                ok: false,
                status: null,
                durationMs: Date.now() - startedAt,
                error: error?.name === "AbortError" ? "timeout" : error?.message || String(error),
            });
        } finally {
            clearTimeout(timer);
        }
    }
    return {
        ok: false,
        ownerId: owner,
        method,
        selected: null,
        error: "broker-rpc-unavailable",
        launch,
        attempts,
    };
}

export async function brokerLease(options = {}) {
    const action = typeof options.action === "string" ? options.action : "";
    const methodByAction = {
        claim: "broker.lease.claim",
        list: "broker.lease.list",
        release: "broker.lease.release",
    };
    const method = methodByAction[action];
    if (!method) {
        return {
            ok: false,
            ownerId: ownerId(),
            error: "invalid-lease-action",
            allowed: Object.keys(methodByAction),
            attempts: [],
        };
    }
    return brokerRpcRequest({
        ...options,
        method,
        params: {
            backend: options.backend,
            hardwareId: options.hardwareId,
            deviceId: options.deviceId,
            connection: options.connection,
            transport: options.transport,
            all: options.all,
        },
    });
}

export async function brokerPhysical(options = {}) {
    const action = typeof options.action === "string" ? options.action : "";
    const methodByAction = {
        attach: "broker.physical.attach",
        detach: "broker.physical.detach",
        list: "broker.physical.list",
    };
    const method = methodByAction[action];
    if (!method) {
        return {
            ok: false,
            ownerId: ownerId(),
            error: "invalid-physical-action",
            allowed: Object.keys(methodByAction),
            attempts: [],
        };
    }
    return brokerRpcRequest({
        ...options,
        method,
        params: {
            backend: options.backend,
            name: options.name,
            deviceId: options.deviceId,
            serial: options.serial,
            udid: options.udid,
            connection: options.connection,
            host: options.host,
            port: options.devicePort,
        },
    });
}

export async function brokerCommand(options = {}) {
    const action = typeof options.action === "string" ? options.action : "";
    const methodByAction = {
        plan: "broker.command.plan",
        invoke: "broker.command.invoke",
    };
    const method = methodByAction[action];
    if (!method) {
        return {
            ok: false,
            ownerId: ownerId(),
            error: "invalid-command-action",
            allowed: Object.keys(methodByAction),
            attempts: [],
        };
    }
    return brokerRpcRequest({
        ...options,
        method,
        params: {
            backend: options.backend,
            command: options.command,
            deviceId: options.deviceId,
            force: options.force,
            dryRun: options.dryRun,
        },
    });
}

export async function brokerStatus(options = {}) {
    const owner = ownerId();
    const root = brokerStateRoot();
    let launch = null;
    if (options.shutdown === true) {
        return {
            ownerId: owner,
            mode: "broker-shutdown",
            lazy: true,
            available: false,
            shutdown: await brokerShutdown(options),
        };
    }
    if (options.autolaunch === true) {
        launch = await ensureBroker(options);
    }
    const probeOptions = normalizeProbeOptions(options);
    const effectiveProbeOptions = launch?.ok ? { ...probeOptions, probe: true, hostCandidates: [launch.host], port: launch.port } : probeOptions;
    const probe = effectiveProbeOptions.probe
        ? await probeBrokerHealth(effectiveProbeOptions)
        : { requested: false, available: false, selected: null, attempts: [] };
    const runtime = readBrokerRuntime();
    return {
        ownerId: owner,
        mode: probe.available ? "host-broker-detected" : "direct-provider",
        lazy: true,
        available: probe.available,
        startupPolicy: "status/backend discovery do not start devices; broker autolaunch starts only on explicit autolaunch=true",
        transport: {
            preferred: "http",
            hostCandidates: effectiveProbeOptions.hostCandidates,
            defaultPort: effectiveProbeOptions.port,
            zeroConfig: true,
            environmentRequired: false,
            probeTimeoutMs: effectiveProbeOptions.timeoutMs,
            maxProbeCandidates: MAX_PROBE_CANDIDATES,
            maxProbeTimeoutMs: MAX_PROBE_TIMEOUT_MS,
            maxLaunchTimeoutMs: MAX_LAUNCH_TIMEOUT_MS,
        },
        probe,
        launch,
        runtime,
        state: {
            root,
            ownerRoot: join(root, "owners", owner),
            locksRoot: join(root, "broker", "locks"),
            logsRoot: join(root, "broker", "logs"),
            runtimeFile: brokerRuntimeFile(),
        },
        implemented: [
            "owner-scoped direct provider adapters",
            "owner-scoped state layout",
            "physical device lease files",
            "explicit all-owner admin cleanup commands",
            "broker contract inspection",
            "broker health probe",
            "explicit broker RPC diagnostic transport",
            "explicit broker physical lease diagnostics",
            "explicit broker lifecycle command dry-run diagnostics",
            "lazy host broker autolaunch",
            "mcp-owned broker shutdown",
            "broker runtime pid metadata",
            "secret-backed broker owner token auth",
        ],
        deferred: [
            "permanent host service manager integration",
            "full direct-provider routing parity through broker",
        ],
        note: "Device backends remain lazy. Broker autolaunch starts only the broker process and does not start emulators, simulators, sandboxes, VMs, Appium, or provider tools.",
    };
}
