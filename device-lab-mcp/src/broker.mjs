import { createHash, createHmac, randomBytes } from "crypto";
import { spawn, spawnSync } from "child_process";
import { accessSync, closeSync, constants as fsConstants, existsSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, unlinkSync } from "fs";
import { request as httpRequest } from "http";
import { homedir } from "os";
import { delimiter, dirname, join, resolve } from "path";
import { ownerBasis, ownerId, PACKAGE_ROOT, projectMountPath } from "./context.mjs";
import { writeJsonFileAtomically } from "./state/shared-mutation-lock.mjs";
import { readDeviceLabStateFile } from "./state/state-file.mjs";
import { canonicalWindowsPowerShellPath, canonicalWindowsSystemExecutablePath, terminateWindowsProcessByStartToken } from "./state/windows-system-powershell.mjs";

const HOST_CANDIDATES = [
    "127.0.0.1",
    "host.docker.internal",
    "host.containers.internal",
    "gateway.docker.internal",
    "172.17.0.1",
    "10.0.2.2",
];
const MAX_PROBE_CANDIDATES = 8;
const MAX_PROBE_TIMEOUT_MS = 2000;
const TRUSTED_BROKER_HOSTS = new Set(HOST_CANDIDATES);
const BROKER_BIND_ANY_HOSTS = new Set(["0.0.0.0", "::"]);
export const REQUIRED_CCC_HOST_BROKER_CAPABILITIES = [
    "windows-sandbox-window-minimize-v4",
    "constant-time-existing-owner-auth-v1",
    "atomic-owner-secret-provisioning-v1",
    "owner-mutation-serialization-v1",
    "atomic-owner-device-state-v1",
    "cross-process-owner-state-serialization-v1",
    "owner-device-identity-fencing-v1",
    "rpc-fault-containment-v1",
    "cross-owner-physical-lease-serialization-v1",
    "physical-lease-operation-fencing-v1",
    "physical-lifecycle-lease-fencing-v1",
    "physical-attach-detach-operation-serialization-v1",
    "physical-detach-runtime-cleanup-v1",
    "physical-runtime-cleanup-lease-fencing-v1",
    "physical-lease-state-write-rollback-v1",
    "runtime-cleanup-failure-preservation-v1",
    "appium-runtime-generation-fencing-v1",
    "windows-sandbox-singleton-fencing-v1",
    "cross-process-device-operation-serialization-v1",
    "cross-process-device-runtime-serialization-v1",
    "direct-recording-generation-fencing-v1",
    "direct-appium-generation-fencing-v1",
    "finite-device-operation-serialization-v1",
    "direct-runtime-process-identity-v1",
    "host-recording-process-identity-v1",
    "runtime-process-observation-v1",
    "host-appium-process-identity-v1",
    "broker-owned-owner-secret-provisioning-v1",
    "host-broker-port-process-identity-v1",
    "host-broker-process-start-token-v1",
    "owner-generation-hmac-auth-v1",
    "direct-appium-process-identity-v1", "owner-device-state-validation-v1", "shared-device-ownership-state-validation-v1",
    "android-emulator-port-allocation-fencing-v1",
    "bounded-error-responses-v1",
    "physical-lease-directory-fencing-v1",
    "owner-auth-directory-fencing-v1",
    "appium-runtime-installation-fencing-v1",
    "bounded-no-redirect-appium-http-transport-v1",
    "windows-provider-launcher-path-fencing-v1",
    "canonical-owner-device-ids-v1",
    "ios-simulator-owner-identity-fencing-v1",
    "ios-simulator-provider-create-v1",
    "physical-appium-lease-fencing-v1",
    "physical-device-tool-lease-fencing-v1",
    "physical-lifecycle-use-lease-refresh-v1",
    "appium-live-runtime-metadata-fencing-v1",
    "direct-android-lifecycle-generation-fencing-v1",
    "direct-ios-lifecycle-generation-fencing-v1",
    "direct-windows-lifecycle-generation-fencing-v1",
    "direct-macos-lifecycle-generation-fencing-v1",
    "direct-macos-snapshot-clone-generation-fencing-v1",
    "physical-direct-state-transition-fencing-v1",
    "multi-project-owner-resolve-v1",
    "stopped-android-status-observation-v1",
    "stopped-android-boot-metadata-v1",
    "guest-helper-recording-proxy-v1",
    "physical-unattached-wireless-routing-v1",
    "android-recording-signal-fallback-v1",
    "hyper-v-vm-managed-auto-images-v20",
    "hyper-v-setup-network-v10",
    "hyper-v-guest-readiness-diagnostics-v2",
    "hyper-v-azure-ovf-seed-v1",
    "hyper-v-azure-ovf-seed-v2",
    "hyper-v-azure-bootstrap-dhcp-v1",
    "hyper-v-azure-local-ovf-v1",
    "hyper-v-bootstrap-nic-cleanup-v1",
    "hyper-v-bootstrap-ssh-finalize-v2",
    "hyper-v-windows-specialize-seed-v1",
    "hyper-v-windows-specialize-account-v1",
    "hyper-v-windows-boot-contract-v1",
    "hyper-v-boot-disk-generation-v1",
    "hyper-v-linux-create-response-v1",
    "hyper-v-image-acquisition-stage-cache-v1",
    "hyper-v-powershell-stage-propagation-v1",
    "hyper-v-provider-image-finalization-v21",
    "hyper-v-network-failure-diagnostics-v9",
];
const DEFAULT_LIFECYCLE_RPC_TIMEOUT_MS = 120000;
const MAX_RPC_TIMEOUT_MS = 21615000;
const MAX_RPC_BODY_BYTES = 64 * 1024;
export const BROKER_CONTROL_RESPONSE_LIMIT_BYTES = 1024 * 1024;
export const BROKER_RPC_RESPONSE_LIMIT_BYTES = 64 * 1024 * 1024;
const BROKER_INVALID_RESPONSE_RAW_LIMIT_BYTES = 32 * 1024;
const BROKER_AUTH_FILE_LIMIT_BYTES = 4096;
const BROKER_RUNTIME_FILE_LIMIT_BYTES = 64 * 1024;
const BROKER_LOG_TAIL_READ_LIMIT_BYTES = 4 * 1024;
const BROKER_NAME = "ccc-device-broker";
const PUBLIC_BROKER_RPC_METHODS = new Set(["broker.status", "broker.inventory", "broker.backends", "broker.echo"]);
const MAX_LAUNCH_TIMEOUT_MS = 15000;
const ownedBrokerChildren = new Map();
let cleanupRegistered = false;
let exitingFromSignal = false;

function brokerStateRoot() {
    return join(homedir(), ".ccc/devices");
}

function brokerRuntimeFile() {
    return join(brokerStateRoot(), "broker", "runtime.json");
}

function brokerLogsRoot() {
    return join(brokerStateRoot(), "broker", "logs");
}

function brokerLogDirectoryChain() {
    const root = brokerStateRoot();
    return [root, join(root, "broker"), brokerLogsRoot()];
}

function ensureBrokerLogDirectory() {
    const [root, ...children] = brokerLogDirectoryChain();
    try {
        mkdirSync(root, { recursive: true, mode: 0o700 });
    } catch (error) {
        if (error?.code !== "EEXIST") throw new Error("broker-log-directory-create-failed");
    }
    for (const directory of [root, ...children]) {
        if (directory !== root) {
            try {
                mkdirSync(directory, { mode: 0o700 });
            } catch (error) {
                if (error?.code !== "EEXIST") throw new Error("broker-log-directory-create-failed");
            }
        }
        try {
            const stat = lstatSync(directory);
            if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("broker-log-directory-invalid");
        } catch (error) {
            if (error?.message === "broker-log-directory-invalid") throw error;
            throw new Error("broker-log-directory-read-failed");
        }
    }
}

function brokerLogDirectoryValid() {
    try {
        for (const directory of brokerLogDirectoryChain()) {
            const stat = lstatSync(directory);
            if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
        }
        return true;
    } catch {
        return false;
    }
}

function createBrokerLogFile(owner) {
    ensureBrokerLogDirectory();
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    for (let attempt = 0; attempt < 8; attempt += 1) {
        const path = join(brokerLogsRoot(), `broker-${owner}-${Date.now()}-${randomBytes(8).toString("hex")}.log`);
        let descriptor = null;
        try {
            descriptor = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, 0o600);
            const opened = fstatSync(descriptor);
            const current = lstatSync(path);
            if (!opened.isFile() || !current.isFile() || current.isSymbolicLink() || opened.nlink !== 1 || current.nlink !== 1
                || (opened.dev !== 0 && current.dev !== 0 && opened.dev !== current.dev)
                || (opened.ino !== 0 && current.ino !== 0 && opened.ino !== current.ino)) {
                throw new Error("broker-log-file-invalid");
            }
            try { fchmodSync(descriptor, 0o600); } catch { /* best effort on non-POSIX filesystems */ }
            return { path, descriptor };
        } catch (error) {
            if (descriptor !== null) closeSync(descriptor);
            if (error?.code === "EEXIST") continue;
            if (error?.message === "broker-log-file-invalid") throw error;
            throw new Error("broker-log-file-create-failed");
        }
    }
    throw new Error("broker-log-file-create-failed");
}

function brokerContainerContract() {
    const root = brokerStateRoot();
    const rootExists = existsSync(root);
    const incomplete = !rootExists;
    return {
        stateRoot: root,
        stateExists: rootExists,
        deviceStateMounted: rootExists,
        environmentRequired: false,
        ownerResolution: "host-broker-resolve",
        incomplete,
        warnings: incomplete
            ? ["device-lab container wiring is incomplete; the host-backed device state mount is unavailable from this MCP server."]
            : [],
        remedies: incomplete
            ? ["Restart or recreate ccc from the host so the project container has /home/ccc/.ccc/devices mounted."]
            : [],
    };
}

function brokerPersistence(owner = ownerId()) {
    const root = brokerStateRoot();
    const ownerRoot = join(root, "owners", owner);
    const backendStateKeys = ["android", "android-device", "ios", "ios-device", "windows", "windows-vm", "macos", "linux-vm"];
    return {
        root,
        durableAcrossContainerRecreation: true,
        environmentVariablesRequired: false,
        ownerScoped: {
            ownerRoot,
            backendRoots: Object.fromEntries(backendStateKeys.map((stateKey) => [stateKey, join(ownerRoot, stateKey)])),
            deviceDefinitions: Object.fromEntries(backendStateKeys.map((stateKey) => [stateKey, join(ownerRoot, stateKey, "devices.json")])),
            appiumMetadata: "stored on owner device records as appium; broker-owned Appium servers are host processes with owner-scoped metadata",
            recordings: {
                android: join(ownerRoot, "android", "<device-id>", "recordings"),
                ios: join(ownerRoot, "ios", "<device-id>", "recordings"),
                windows: join(ownerRoot, "windows", "<device-id>", "recordings"),
                macos: join(ownerRoot, "macos", "<device-id>", "recordings"),
                metadata: "stored on owner device records as recording",
            },
            helpers: {
                windows: join(ownerRoot, "windows", "<device-id>", "tools"),
                macos: join(ownerRoot, "macos", "<device-id>", "tools"),
            },
            images: {
                androidAvd: "host Android SDK AVD storage; CCC stores owner-prefixed avdName metadata",
                iosSimulator: "host CoreSimulator storage; CCC stores owner-prefixed simulator metadata",
                macosVm: "provider-owned VM instances named from ccc-<owner-id>-<device-id>; metadata is stored under the macos owner root",
                windowsSandbox: "ephemeral Windows Sandbox instances with owner-scoped .wsb/helper/scratch metadata",
            },
            snapshots: {
                macosVm: "Tart snapshots are owner-scoped provider clones recorded on the macos device definition",
            },
        },
        brokerScoped: {
            brokerRoot: join(root, "broker"),
            authRoot: join(root, "broker", "auth"),
            locksRoot: join(root, "broker", "locks"),
            logsRoot: brokerLogsRoot(),
            serviceRoot: join(root, "broker", "service"),
            runtimeFile: brokerRuntimeFile(),
        },
        packagedDependencies: {
            mcpPackageRoot: PACKAGE_ROOT,
            nodeModulesRoot: join(PACKAGE_ROOT, "node_modules"),
            appium: "device-lab-mcp declares appium, appium-uiautomator2-driver, and appium-xcuitest-driver; host-backed automation still records process state in the broker namespace",
        },
        hostToolchains: {
            ownership: "host-owned",
            discovery: "zero-config PATH/provider discovery; no environment variables are required",
            preservedByOwnerCleanup: ["Android SDK/AVDs", "Xcode/CoreSimulator", "Windows Sandbox", "tart/vz/utmctl catalogs", "Appium package installations"],
        },
        cleanupBoundary: {
            ownerCleanupMayMutate: [ownerRoot, join(root, "physical-leases", "<backend>", "locks", "<hardware-id>.json")],
            ownerCleanupPreserves: [
                join(root, "owners", "<foreign-owner-id>"),
                join(root, "broker", "auth"),
                join(root, "broker", "service"),
                join(root, "broker", "logs"),
                "host toolchains and shared/base VM images",
            ],
            staleMetadataPolicy: "owner cleanup clears stale owner appium/recording metadata and retries provider stops without deleting shared toolchain caches or foreign owner state",
        },
    };
}

function plainObject(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function readBrokerRuntime() {
    try {
        return readDeviceLabStateFile(brokerRuntimeFile(), (parsed) => {
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid-broker-runtime");
            if (typeof parsed.host !== "string"
                || (!TRUSTED_BROKER_HOSTS.has(parsed.host) && !BROKER_BIND_ANY_HOSTS.has(parsed.host))) {
                throw new Error("invalid-broker-runtime-host");
            }
            if (parsed.probeHost !== undefined
                && (typeof parsed.probeHost !== "string" || !TRUSTED_BROKER_HOSTS.has(parsed.probeHost))) {
                throw new Error("invalid-broker-runtime-host");
            }
            if (Array.isArray(parsed.hostCandidates)
                && parsed.hostCandidates.some((host) => typeof host !== "string" || !TRUSTED_BROKER_HOSTS.has(host))) {
                throw new Error("invalid-broker-runtime-host");
            }
            return parsed;
        }, "broker-runtime", BROKER_RUNTIME_FILE_LIMIT_BYTES);
    } catch {
        return null;
    }
}

export function implicitBrokerProbeOptions(options = {}, behavior = {}) {
    const allowDefault = behavior?.allowDefault !== false;
    const defaultProbe = (autolaunchDefault = true) => {
        const probe = normalizeProbeOptions({ ...options, probe: true });
        return {
            hostCandidates: probe.hostCandidates,
            port: probe.port,
            timeoutMs: Number.isFinite(options.timeoutMs) ? probe.timeoutMs : 1000,
            autolaunch: options.autolaunch === true || (options.autolaunch !== false && autolaunchDefault),
        };
    };
    if (Array.isArray(options.hostCandidates) || Number.isInteger(options.port)) return defaultProbe(false);
    const runtime = readBrokerRuntime();
    if (!runtime) return allowDefault ? defaultProbe() : null;
    const hostCandidates = runtimeHostCandidates(runtime);
    if (!runtime.host || !Number.isInteger(runtime.port)) return allowDefault ? defaultProbe() : null;
    if (runtime.managedBy === "device-lab-mcp" && runtime.ownerId !== ownerId()) return null;
    if (runtime.managedBy !== "device-lab-mcp" && runtime.managedBy !== "ccc-host") return null;
    return {
        hostCandidates,
        port: runtime.port,
        timeoutMs: Number.isFinite(options.timeoutMs) ? normalizeProbeOptions(options).timeoutMs : 1000,
        autolaunch: options.autolaunch === false ? false : true,
    };
}

function runtimeHostCandidates(runtime) {
    const explicit = Array.isArray(runtime.hostCandidates) ? runtime.hostCandidates.map(String) : [];
    const candidates = [
        ...explicit,
        typeof runtime.probeHost === "string" ? runtime.probeHost : null,
        typeof runtime.host === "string" ? runtime.host : null,
        ...HOST_CANDIDATES,
    ].filter((host) => host && host !== "0.0.0.0" && host !== "::");
    return [...new Set(candidates)].slice(0, MAX_PROBE_CANDIDATES);
}

function writeBrokerRuntime(runtime) {
    writeJsonFileAtomically(brokerRuntimeFile(), runtime);
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
    if (process.platform === "linux") {
        try {
            const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
            const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
            if (state === "Z") return false;
        } catch {
            // Missing /proc metadata falls through to the portable signal probe.
        }
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function executableExtensions(executable) {
    return process.platform === "win32" && !/\.[^\\/]+$/.test(executable)
        ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
        : [""];
}

function executableExists(executable) {
    if (executable.includes("/") || executable.includes("\\")) {
        try {
            accessSync(executable, fsConstants.X_OK);
            return true;
        } catch {
            return false;
        }
    }
    for (const pathEntry of (process.env.PATH || "").split(delimiter).filter(Boolean)) {
        for (const extension of executableExtensions(executable)) {
            try {
                accessSync(join(pathEntry, `${executable}${extension}`), fsConstants.X_OK);
                return true;
            } catch {
                // Continue PATH lookup without invoking a shell.
            }
        }
    }
    return false;
}

function packagedCccCliPath(packageRoot = PACKAGE_ROOT) {
    const candidates = [
        join(packageRoot, "index.js"),
        join(packageRoot, "..", "dist", "index.js"),
    ];
    return candidates.find((candidate) => existsSync(candidate)) || null;
}

export function brokerLaunchInvocation(host, port, options = {}) {
    const platform = options.platform || process.platform;
    const cliPath = platform === "win32" ? packagedCccCliPath(options.packageRoot) : null;
    const brokerArgs = ["devices", "broker", "serve", "--host", host, "--port", String(port)];
    return cliPath
        ? { command: options.execPath || process.execPath, args: [cliPath, ...brokerArgs] }
        : { command: "ccc", args: brokerArgs };
}

function normalizeLaunchOptions(options = {}) {
    const probeOptions = normalizeProbeOptions({ ...options, probe: true });
    const launchTimeoutMs = Number.isFinite(options.launchTimeoutMs)
        ? Math.min(MAX_LAUNCH_TIMEOUT_MS, Math.max(1, Number(options.launchTimeoutMs)))
        : process.platform === "win32" ? 10000 : 2500;
    const host = typeof options.launchHost === "string" && options.launchHost
        ? options.launchHost
        : (probeOptions.hostCandidates.includes("127.0.0.1") ? "127.0.0.1" : probeOptions.hostCandidates[0] || "127.0.0.1");
    const invocation = brokerLaunchInvocation(host, probeOptions.port);
    return {
        ...probeOptions,
        host,
        port: probeOptions.port,
        launchTimeoutMs,
        ...invocation,
    };
}

export function brokerLogTail(logPath, limit = 1000) {
    let descriptor = null;
    try {
        if (typeof logPath !== "string" || resolve(dirname(logPath)) !== resolve(brokerLogsRoot())) return "";
        if (!brokerLogDirectoryValid()) return "";
        const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
        descriptor = openSync(logPath, fsConstants.O_RDONLY | noFollow);
        const opened = fstatSync(descriptor);
        const current = lstatSync(logPath);
        if (!opened.isFile() || !current.isFile() || current.isSymbolicLink() || opened.nlink !== 1 || current.nlink !== 1
            || (opened.dev !== 0 && current.dev !== 0 && opened.dev !== current.dev)
            || (opened.ino !== 0 && current.ino !== 0 && opened.ino !== current.ino)) return "";
        const length = Math.min(BROKER_LOG_TAIL_READ_LIMIT_BYTES, opened.size);
        const buffer = Buffer.allocUnsafe(length);
        let total = 0;
        while (total < length) {
            const count = readSync(descriptor, buffer, total, length - total, opened.size - length + total);
            if (count === 0) break;
            total += count;
        }
        const text = buffer.subarray(0, total).toString("utf8").trim();
        return text.length > limit ? text.slice(-limit) : text;
    } catch {
        return "";
    } finally {
        if (descriptor !== null) {
            try { closeSync(descriptor); } catch { /* best effort after a diagnostic read */ }
        }
    }
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

function normalizeRpcTimeoutMs(options = {}, fallbackMs) {
    const value = Number.isFinite(options.rpcTimeoutMs) ? options.rpcTimeoutMs : options.timeoutMs;
    return Number.isFinite(value)
        ? Math.min(MAX_RPC_TIMEOUT_MS, Math.max(1, Number(value)))
        : fallbackMs;
}

function brokerTransportFailure(error) {
    const message = error?.name === "AbortError" ? "timeout" : error?.message || String(error);
    const rawCode = typeof error?.code === "string" && /^[A-Z0-9_]{2,32}$/.test(error.code)
        ? error.code
        : "";
    const normalized = String(message).toLowerCase();
    const transportCode = message === "timeout"
        ? "timeout"
        : rawCode === "ECONNRESET" || normalized.includes("socket hang up")
            ? "connection-reset"
            : rawCode === "ECONNREFUSED" || normalized.includes("connection refused")
                ? "connection-refused"
                : rawCode === "EPIPE"
                    ? "broken-pipe"
                    : normalized.includes("response aborted")
                        ? "response-aborted"
                        : "transport-error";
    return {
        error: message,
        transportCode,
        retryable: ["connection-reset", "connection-refused", "broken-pipe", "response-aborted"].includes(transportCode),
    };
}

function hyperVCreateTransportRetryEligible(options, method, attempts) {
    const params = options?.params;
    const lastAttempt = attempts.at(-1);
    return options?.__hyperVCreateTransportRetryAttempted !== true
        && method === "broker.command.invoke"
        && params && typeof params === "object"
        && ["windows-vm", "linux-vm"].includes(params.backend)
        && params.command === "device_create"
        && typeof params.deviceId === "string"
        && params.deviceId.length > 0
        && lastAttempt?.status === null
        && lastAttempt?.transportRetryable === true;
}

function brokerLogDiagnosticCodes(launch) {
    const logPath = launch?.runtime?.logPath || launch?.logPath;
    const log = brokerLogTail(logPath, BROKER_LOG_TAIL_READ_LIMIT_BYTES);
    const matches = log.match(/\b(?:appium|broker|hyper-v|powershell|ssh)-[a-z0-9-]{2,128}\b/g) || [];
    return [...new Set(matches)].slice(-8);
}

function summarizeBrokerTransportFailure(attempts, launch) {
    const lastAttempt = attempts.at(-1);
    return {
        host: lastAttempt?.host,
        port: lastAttempt?.port,
        error: lastAttempt?.transportCode || "transport-error",
        durationMs: lastAttempt?.durationMs,
        brokerPid: Number.isSafeInteger(launch?.runtime?.pid) ? launch.runtime.pid : undefined,
        brokerDiagnostics: brokerLogDiagnosticCodes(launch),
    };
}

function boundedBrokerRawText(text) {
    const bytes = Buffer.from(text, "utf8");
    if (bytes.length <= BROKER_INVALID_RESPONSE_RAW_LIMIT_BYTES) return text;
    const suffix = "...[truncated]";
    const suffixBytes = Buffer.byteLength(suffix, "utf8");
    let prefix = bytes.subarray(0, BROKER_INVALID_RESPONSE_RAW_LIMIT_BYTES - suffixBytes).toString("utf8");
    while (Buffer.byteLength(prefix, "utf8") + suffixBytes > BROKER_INVALID_RESPONSE_RAW_LIMIT_BYTES) {
        prefix = prefix.slice(0, -1);
    }
    return `${prefix}${suffix}`;
}

async function readBrokerHttpJson(response, maxBytes) {
    if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        return { ok: false, error: "broker-redirect-disallowed", body: null, maxBytes };
    }
    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null && /^\d+$/.test(declaredLength)) {
        try {
            if (BigInt(declaredLength) > BigInt(maxBytes)) {
                await response.body?.cancel().catch(() => undefined);
                return { ok: false, error: "broker-response-too-large", body: null, declaredBytes: declaredLength, maxBytes };
            }
        } catch {
            await response.body?.cancel().catch(() => undefined);
            return { ok: false, error: "invalid-broker-content-length", body: null, maxBytes };
        }
    }
    if (!response.body) return { ok: false, error: "invalid-broker-json", body: null, receivedBytes: 0, maxBytes };

    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) {
                await reader.cancel().catch(() => undefined);
                return { ok: false, error: "broker-response-too-large", body: null, receivedBytes: total, maxBytes };
            }
            chunks.push(Buffer.from(value));
        }
    } finally {
        reader.releaseLock();
    }

    const text = Buffer.concat(chunks, total).toString("utf8");
    try {
        const body = text ? JSON.parse(text) : null;
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("broker response is not an object");
        return { ok: true, body, receivedBytes: total, maxBytes };
    } catch {
        return {
            ok: false,
            error: "invalid-broker-json",
            body: { raw: boundedBrokerRawText(text) },
            receivedBytes: total,
            maxBytes,
        };
    }
}

function brokerRpcHttpJsonRequest({ host, port, path, headers, body, timeoutMs, maxBytes }) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            callback(value);
        };
        const request = httpRequest({
            host,
            port,
            path,
            method: "POST",
            headers: {
                ...headers,
                "content-length": String(Buffer.byteLength(body)),
                connection: "close",
            },
            agent: false,
        });
        const timer = setTimeout(() => {
            const error = new Error("broker RPC timed out");
            error.name = "AbortError";
            request.destroy(error);
        }, timeoutMs);
        request.once("response", (response) => {
            const status = Number(response.statusCode || 0);
            if (status >= 300 && status < 400) {
                response.destroy();
                finish(resolve, {
                    status,
                    ok: false,
                    responseBody: { ok: false, error: "broker-redirect-disallowed", body: null, maxBytes },
                });
                return;
            }
            const declaredLength = Array.isArray(response.headers["content-length"])
                ? response.headers["content-length"][0]
                : response.headers["content-length"];
            if (typeof declaredLength === "string" && /^\d+$/.test(declaredLength)
                && BigInt(declaredLength) > BigInt(maxBytes)) {
                response.destroy();
                finish(resolve, {
                    status,
                    ok: status >= 200 && status < 300,
                    responseBody: {
                        ok: false,
                        error: "broker-response-too-large",
                        body: null,
                        declaredBytes: declaredLength,
                        maxBytes,
                    },
                });
                return;
            }
            const chunks = [];
            let total = 0;
            response.on("data", (chunk) => {
                if (settled) return;
                const bytes = Buffer.from(chunk);
                total += bytes.length;
                if (total > maxBytes) {
                    response.destroy();
                    finish(resolve, {
                        status,
                        ok: status >= 200 && status < 300,
                        responseBody: {
                            ok: false,
                            error: "broker-response-too-large",
                            body: null,
                            receivedBytes: total,
                            maxBytes,
                        },
                    });
                    return;
                }
                chunks.push(bytes);
            });
            response.once("end", () => {
                if (settled) return;
                const text = Buffer.concat(chunks, total).toString("utf8");
                try {
                    const parsed = text ? JSON.parse(text) : null;
                    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("broker response is not an object");
                    finish(resolve, {
                        status,
                        ok: status >= 200 && status < 300,
                        responseBody: { ok: true, body: parsed, receivedBytes: total, maxBytes },
                    });
                } catch {
                    finish(resolve, {
                        status,
                        ok: status >= 200 && status < 300,
                        responseBody: {
                            ok: false,
                            error: "invalid-broker-json",
                            body: { raw: boundedBrokerRawText(text) },
                            receivedBytes: total,
                            maxBytes,
                        },
                    });
                }
            });
            response.once("aborted", () => finish(reject, new Error("broker response aborted")));
            response.once("error", (error) => finish(reject, error));
        });
        request.once("error", (error) => finish(reject, error));
        request.end(body);
    });
}

async function probeBrokerHealth({ hostCandidates, port, timeoutMs }) {
    const attempts = [];
    for (const host of hostCandidates) {
        const endpoint = `http://${host}:${port}/health`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const startedAt = Date.now();
        try {
            const response = await fetch(endpoint, { signal: controller.signal, redirect: "manual" });
            const parsed = await readBrokerHttpJson(response, BROKER_CONTROL_RESPONSE_LIMIT_BYTES);
            const body = parsed.body;
            const protocolOk = parsed.ok && response.ok && body?.ok === true && body?.name === BROKER_NAME;
            const attempt = {
                host,
                port,
                endpoint,
                ok: protocolOk,
                status: response.status,
                durationMs: Date.now() - startedAt,
                body,
                ...(parsed.ok ? {} : { error: parsed.error, maxBytes: parsed.maxBytes }),
            };
            attempts.push(attempt);
            if (protocolOk) return { requested: true, available: true, selected: attempt, attempts };
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

async function probeCccHostBrokerCapabilities(host, port, timeoutMs) {
    const endpoint = `http://${host}:${port}/status`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    try {
        const response = await fetch(endpoint, { signal: controller.signal, redirect: "manual" });
        const parsed = await readBrokerHttpJson(response, BROKER_CONTROL_RESPONSE_LIMIT_BYTES);
        const body = parsed.body;
        const implemented = Array.isArray(body?.broker?.implemented) ? body.broker.implemented.map(String) : [];
        const missingCapabilities = REQUIRED_CCC_HOST_BROKER_CAPABILITIES.filter((capability) => !implemented.includes(capability));
        return {
            ok: parsed.ok && response.ok && body?.ok === true && missingCapabilities.length === 0,
            endpoint,
            status: response.status,
            body,
            missingCapabilities,
            durationMs: Date.now() - startedAt,
            ...(parsed.ok ? {} : { error: parsed.error, maxBytes: parsed.maxBytes }),
        };
    } catch (error) {
        return {
            ok: false,
            endpoint,
            status: null,
            body: null,
            missingCapabilities: REQUIRED_CCC_HOST_BROKER_CAPABILITIES,
            durationMs: Date.now() - startedAt,
            error: error?.name === "AbortError" ? "timeout" : error?.message || String(error),
        };
    } finally {
        clearTimeout(timer);
    }
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

function cleanupOwnedBrokerChildrenOnExit() {
    for (const [pid, owned] of ownedBrokerChildren.entries()) {
        const child = owned?.child || owned;
        const expectedStartToken = owned?.processStartToken || null;
        if (expectedStartToken && readBrokerProcessStartToken(pid) === expectedStartToken) {
            try { child.kill?.("SIGTERM"); } catch { /* preserve runtime evidence */ }
        }
        ownedBrokerChildren.delete(pid);
    }
}

async function cleanupOwnedBrokerChildren() {
    const confirmedOwnedExits = new Map();
    for (const [pid, owned] of ownedBrokerChildren.entries()) {
        const child = owned?.child || owned;
        const expectedStartToken = owned?.processStartToken || null;
        if (!expectedStartToken || readBrokerProcessStartToken(pid) !== expectedStartToken) {
            ownedBrokerChildren.delete(pid);
            continue;
        }
        let termination = await terminateBrokerProcess(pid, 500, expectedStartToken);
        if (!termination.ok
            && !termination.reason
            && readBrokerProcessStartToken(pid) === expectedStartToken) {
            try { child.kill?.("SIGKILL"); } catch { /* checked below */ }
            termination = {
                ok: await waitForProcessExit(pid, 500),
                pid,
                reason: "forced-signal-cleanup",
            };
        }
        if (termination.ok && !pidAlive(pid)) confirmedOwnedExits.set(pid, expectedStartToken);
        ownedBrokerChildren.delete(pid);
    }
    const runtime = readBrokerRuntime();
    const confirmedRuntimeExit = runtime
        && confirmedOwnedExits.get(Number(runtime.pid)) === runtime.processStartToken;
    if (confirmedRuntimeExit
        && runtime.managedBy === "device-lab-mcp"
        && runtime.ownerId === ownerId()) {
        removeBrokerRuntime();
    }
}

function registerBrokerCleanup() {
    if (cleanupRegistered) return;
    cleanupRegistered = true;
    process.once("exit", cleanupOwnedBrokerChildrenOnExit);
    for (const signal of ["SIGINT", "SIGTERM"]) {
        process.once(signal, async () => {
            await cleanupOwnedBrokerChildren();
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

async function terminateBrokerProcess(pid, timeoutMs = 3000, expectedStartToken = null) {
    if (!pidAlive(pid)) return { ok: true, stale: true, pid };
    if (!expectedStartToken) {
        return { ok: false, pid, reason: "process-start-token-unavailable" };
    }
    const currentStartToken = readBrokerProcessStartToken(pid);
    if (!currentStartToken || currentStartToken !== expectedStartToken) {
        return {
            ok: false,
            pid,
            reason: currentStartToken ? "process-start-token-mismatch" : "process-start-token-unavailable",
        };
    }
    if (process.platform === "win32") {
        return terminateWindowsProcessByStartToken(pid, expectedStartToken, timeoutMs);
    }
    try {
        process.kill(pid, "SIGTERM");
    } catch {
        return { ok: !pidAlive(pid), pid, method: "signal" };
    }
    const exited = await waitForProcessExit(pid, timeoutMs);
    return { ok: exited, pid, method: "signal" };
}

function isBrokerServeCommandLine(commandLine, port, expectedCliPath) {
    const normalized = String(commandLine || "").replace(/["']/g, " ").replace(/\s+/g, " ").trim();
    const normalizedPath = (value) => String(value || "").replace(/["']/g, "").replace(/\\/g, "/").toLowerCase();
    const commandTokens = Array.from(String(commandLine || "").matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g), (match) => match[1] ?? match[2] ?? match[3]);
    const expectedPathVerified = !expectedCliPath || (commandTokens.length > 1
        && /(?:^|\/)node(?:\.exe)?$/i.test(normalizedPath(commandTokens[0]))
        && normalizedPath(commandTokens[1]) === normalizedPath(expectedCliPath));
    return /\bdevices\s+broker\s+serve\b/i.test(normalized)
        && (/\bccc(?:\.cmd|\.exe)?\b/i.test(normalized) || /\bnode(?:\.exe)?\b.*\bindex\.js\b/i.test(normalized))
        && new RegExp(`(?:^|\\s)--port(?:=|\\s+)${port}(?:\\s|$)`).test(normalized)
        && expectedPathVerified;
}

function discoverLinuxBrokerPortProcess(port) {
    const portHex = Number(port).toString(16).toUpperCase().padStart(4, "0");
    const inodes = new Set();
    for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
        try {
            const lines = readFileSync(file, "utf8").trim().split(/\n/).slice(1);
            for (const line of lines) {
                const fields = line.trim().split(/\s+/);
                if (fields[3] === "0A" && (fields[1] || "").split(":").pop() === portHex && fields[9]) inodes.add(fields[9]);
            }
        } catch {
            // Port ownership may be hidden by the container or procfs policy.
        }
    }
    if (inodes.size === 0) return null;
    try {
        for (const pidText of readdirSync("/proc").filter((entry) => /^\d+$/.test(entry))) {
            let fds = [];
            try { fds = readdirSync(`/proc/${pidText}/fd`); } catch { continue; }
            for (const fd of fds) {
                let target = "";
                try { target = readlinkSync(`/proc/${pidText}/fd/${fd}`); } catch { continue; }
                const match = /^socket:\[(\d+)\]$/.exec(target);
                if (!match || !inodes.has(match[1])) continue;
                let commandLine = "";
                try { commandLine = readFileSync(`/proc/${pidText}/cmdline`, "utf8").replace(/\0/g, " ").trim(); } catch { /* diagnostic only */ }
                let processStartToken = null;
                try {
                    const stat = readFileSync(`/proc/${pidText}/stat`, "utf8");
                    const close = stat.lastIndexOf(")");
                    const fields = close >= 0 ? stat.slice(close + 1).trim().split(/\s+/) : [];
                    processStartToken = fields[19] ? `linux:${fields[19]}` : null;
                } catch { /* diagnostic only */ }
                return { pid: Number(pidText), commandLine, processStartToken };
            }
        }
    } catch {
        return null;
    }
    return null;
}

function discoverCommandBrokerPortProcess(command, args) {
    const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, timeout: 1000 });
    const pid = Number((result.stdout?.match(/^p(\d+)$/m) || [])[1]);
    if (result.status !== 0 || !Number.isInteger(pid) || pid <= 0) return null;
    const ps = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", windowsHide: true, timeout: 1000 });
    const started = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", windowsHide: true, timeout: 1000 });
    const startedAt = started.status === 0 ? String(started.stdout || "").trim() : "";
    return { pid, commandLine: String(ps.stdout || "").trim(), processStartToken: startedAt ? `ps:${startedAt}` : null };
}

export function parseWindowsNetstatListenerForTest(output, port) {
    const expectedPort = Number(port);
    if (!Number.isInteger(expectedPort) || expectedPort < 1 || expectedPort > 65535) return null;
    for (const line of String(output || "").split(/\r?\n/)) {
        const fields = line.trim().split(/\s+/);
        if (fields.length < 5 || fields[0]?.toUpperCase() !== "TCP") continue;
        const localAddress = String(fields[1] || "");
        const remoteAddress = String(fields[2] || "");
        const portMatch = /:(\d+)$/.exec(localAddress);
        const remotePortMatch = /:(\d+)$/.exec(remoteAddress);
        const pid = Number(fields.at(-1));
        if (Number(portMatch?.[1]) === expectedPort
            && Number(remotePortMatch?.[1]) === 0
            && Number.isInteger(pid)
            && pid > 0) {
            return { pid, commandLine: "" };
        }
    }
    return null;
}

function discoverWindowsBrokerPortProcess(port) {
    const powershell = canonicalWindowsPowerShellPath();
    const script = [
        `$c = Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -First 1`,
        "if (-not $c) { exit 1 }",
        "$p = Get-CimInstance Win32_Process -Filter \"ProcessId=$($c.OwningProcess)\"",
        "$h = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue",
        "if (-not $p -or -not $h) { exit 1 }",
        "[pscustomobject]@{ pid = [int]$c.OwningProcess; commandLine = [string]$p.CommandLine; startToken = $h.StartTime.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress",
    ].join("; ");
    const result = powershell ? spawnSync(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 1500,
    }) : { status: null, stdout: "" };
    if (result.status === 0 && result.stdout) {
        try {
            const parsed = JSON.parse(result.stdout);
            const pid = Number(parsed?.pid);
            if (Number.isInteger(pid) && pid > 0) {
                return {
                    pid,
                    commandLine: typeof parsed?.commandLine === "string" ? parsed.commandLine.replace(/\r?\n/g, " ").trim() : "",
                    processStartToken: typeof parsed?.startToken === "string" ? `windows:${parsed.startToken}` : null,
                };
            }
        } catch {
            // Fall through to the locale-independent netstat listener lookup.
        }
    }
    const netstatPath = canonicalWindowsSystemExecutablePath("netstat.exe");
    const netstat = netstatPath ? spawnSync(netstatPath, ["-ano", "-p", "tcp"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 1500,
    }) : { status: null, stdout: "" };
    const listener = netstat.status === 0 ? parseWindowsNetstatListenerForTest(netstat.stdout, port) : null;
    if (!listener) return null;
    return { ...listener, processStartToken: readBrokerProcessStartToken(listener.pid, "win32") };
}

function discoverBrokerPortProcess(port) {
    if (process.platform === "linux") return discoverLinuxBrokerPortProcess(port);
    if (process.platform === "darwin") return discoverCommandBrokerPortProcess("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"]);
    if (process.platform === "win32") return discoverWindowsBrokerPortProcess(port);
    return null;
}

function readBrokerProcessStartToken(pid, platform = process.platform) {
    if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return null;
    if (platform === "linux") {
        try {
            const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
            const close = stat.lastIndexOf(")");
            const fields = close >= 0 ? stat.slice(close + 1).trim().split(/\s+/) : [];
            return fields[19] ? `linux:${fields[19]}` : null;
        } catch {
            return null;
        }
    }
    if (platform === "win32") {
        const powershell = canonicalWindowsPowerShellPath();
        if (!powershell) return null;
        const script = `$P = Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue; if ($P) { [Console]::Out.Write($P.StartTime.ToUniversalTime().ToString('o')) }`;
        const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
            encoding: "utf8",
            windowsHide: true,
            timeout: 1500,
        });
        const value = result.status === 0 ? String(result.stdout || "").trim() : "";
        return value ? `windows:${value}` : null;
    }
    const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 1000,
    });
    const value = result.status === 0 ? String(result.stdout || "").trim() : "";
    return value ? `ps:${value}` : null;
}

function verifiedBrokerProcess(
    runtime,
    port = Number(runtime?.port),
    statusBroker = null,
    portProcessResolver = discoverBrokerPortProcess,
) {
    const pid = Number(runtime?.pid);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port)) return null;
    const observed = portProcessResolver(port);
    const command = String(runtime?.command || "").replace(/\\/g, "/");
    const nodeLaunch = /(?:^|\/)node(?:\.exe)?$/i.test(command);
    const expectedCliPath = nodeLaunch && Array.isArray(runtime?.args) && typeof runtime.args[0] === "string"
        ? runtime.args[0]
        : null;
    if (!observed || observed.pid !== pid) return null;
    const observedStartToken = typeof observed.processStartToken === "string"
        ? observed.processStartToken
        : "";
    const runtimeStartToken = typeof runtime?.processStartToken === "string"
        ? runtime.processStartToken
        : "";
    const statusPid = Number(statusBroker?.process?.pid);
    const statusStartToken = typeof statusBroker?.process?.startToken === "string"
        ? statusBroker.process.startToken
        : "";
    const statusStartedAt = typeof statusBroker?.startedAt === "string" ? statusBroker.startedAt : "";
    const runtimeStartedAt = typeof runtime?.startedAt === "string" ? runtime.startedAt : "";
    const runtimeContinuity = observedStartToken.length > 0
        && (observedStartToken === runtimeStartToken
            || (!runtimeStartToken && statusStartedAt.length > 0 && statusStartedAt === runtimeStartedAt));
    const statusProcessVerified = statusBroker?.name === BROKER_NAME
        && statusBroker?.mode === "host-broker-daemon"
        && Number(statusBroker?.port) === port
        && statusPid === pid
        && statusStartToken.length > 0
        && observedStartToken === statusStartToken
        && statusStartedAt.length > 0;
    if (!statusProcessVerified) return null;
    if (isBrokerServeCommandLine(observed.commandLine, port, expectedCliPath)) {
        return runtimeContinuity
            ? { ...observed, source: "port-process-plus-runtime-and-status" }
            : null;
    }
    return !String(observed.commandLine || "").trim()
        && runtimeContinuity
        && statusStartedAt === runtimeStartedAt
        ? { ...observed, source: "port-pid-plus-runtime-and-status" }
        : null;
}

export const verifiedBrokerProcessForTest = verifiedBrokerProcess;

function verifiedOwnedLegacyBrokerProcess(runtime, port, statusBroker, portProcessResolver = discoverBrokerPortProcess) {
    if (runtime?.managedBy !== "device-lab-mcp"
        || !Number.isInteger(Number(runtime.pid))
        || typeof runtime.processStartToken !== "string"
        || !runtime.processStartToken
        || typeof runtime.startedAt !== "string"
        || !runtime.startedAt
        || statusBroker?.startedAt !== runtime.startedAt) {
        return null;
    }
    const statusPid = Number(statusBroker?.process?.pid);
    if (Number.isInteger(statusPid) && statusPid > 0 && statusPid !== Number(runtime.pid)) return null;
    const observed = portProcessResolver(Number(port));
    if (!observed
        || observed.pid !== Number(runtime.pid)
        || observed.processStartToken !== runtime.processStartToken
        || !isBrokerServeCommandLine(observed.commandLine, Number(port), runtime.args?.[0])) {
        return null;
    }
    return observed;
}

function reusableBrokerProcessVerification(runtime, port, host, options = {}) {
    const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV;
    const testEscape = options.testEscape ?? process.env.CCC_DEVICE_LAB_TEST_ALLOW_UNVERIFIED_BROKER;
    if (nodeEnv === "test" && testEscape === "1") {
        return { ok: true, source: "explicit-test-fixture" };
    }
    const normalizedHost = String(host || "").trim().toLowerCase();
    const loopback = normalizedHost === "127.0.0.1" || normalizedHost === "localhost" || normalizedHost === "::1";
    const containerBoundary = options.containerBoundary ?? existsSync("/.dockerenv");
    if (runtime?.managedBy === "ccc-host"
        && containerBoundary
        && !loopback
        && TRUSTED_BROKER_HOSTS.has(normalizedHost)) {
        return { ok: true, source: "cross-host-container-boundary" };
    }
    const processVerifier = options.processVerifier || verifiedBrokerProcess;
    const verified = processVerifier(runtime, port, options.statusBroker || null);
    return verified
        ? { ok: true, source: verified.source, verified }
        : { ok: false, source: "unverified-broker-port-process" };
}

export const reusableBrokerProcessVerificationForTest = reusableBrokerProcessVerification;

function persistVerifiedBrokerRuntime(runtime, processVerification, statusBroker) {
    const processStartToken = typeof processVerification?.verified?.processStartToken === "string"
        ? processVerification.verified.processStartToken
        : typeof statusBroker?.process?.startToken === "string"
            ? statusBroker.process.startToken
            : null;
    const startedAt = typeof statusBroker?.startedAt === "string"
        ? statusBroker.startedAt
        : runtime?.startedAt;
    if (!runtime || !processStartToken || !startedAt) return runtime;
    if (runtime.processStartToken === processStartToken && runtime.startedAt === startedAt) return runtime;
    const verifiedRuntime = { ...runtime, processStartToken, startedAt };
    writeBrokerRuntime(verifiedRuntime);
    return verifiedRuntime;
}

function launchedBrokerProcessVerification(runtime, port, host, statusBroker, options = {}) {
    const statusPid = Number(statusBroker?.process?.pid);
    const statusStartedAt = typeof statusBroker?.startedAt === "string" ? statusBroker.startedAt : "";
    const statusStartToken = typeof statusBroker?.process?.startToken === "string"
        ? statusBroker.process.startToken
        : "";
    const runtimeStartToken = typeof runtime?.processStartToken === "string"
        ? runtime.processStartToken
        : "";
    const attestedRuntime = statusPid === Number(runtime?.pid)
        && statusStartedAt
        && statusStartToken
        && (!runtimeStartToken || runtimeStartToken === statusStartToken)
        ? { ...runtime, startedAt: statusStartedAt, processStartToken: statusStartToken }
        : runtime;
    const verification = reusableBrokerProcessVerification(
        attestedRuntime,
        port,
        host,
        { ...options, statusBroker },
    );
    return { verification, runtime: attestedRuntime };
}

export const launchedBrokerProcessVerificationForTest = launchedBrokerProcessVerification;

async function terminateVerifiedBrokerRuntime(runtime, timeoutMs = 3000, options = {}) {
    const verified = verifiedBrokerProcess(
        runtime,
        Number(runtime?.port),
        options.statusBroker || null,
        options.portProcessResolver || discoverBrokerPortProcess,
    );
    if (!verified) return { ok: false, pid: runtime?.pid, reason: "unverified-broker-port-process" };
    const expectedStartToken = verified.processStartToken
        || runtime?.processStartToken
        || null;
    if (!expectedStartToken) {
        return { ok: false, pid: runtime?.pid, reason: "process-start-token-unavailable", verified };
    }
    const termination = await (options.terminator || terminateBrokerProcess)(
        verified.pid,
        timeoutMs,
        expectedStartToken,
    );
    return { ...termination, verified };
}

export const terminateVerifiedBrokerRuntimeForTest = terminateVerifiedBrokerRuntime;

async function cleanupLaunchedBrokerRuntime(runtime, child, timeoutMs) {
    if (!child?.pid) {
        removeBrokerRuntime();
        return { ok: true, stale: true, pid: null };
    }
    let termination;
    try {
        termination = await terminateBrokerProcess(
            child.pid,
            timeoutMs,
            runtime?.processStartToken || null,
        );
    } catch (error) {
        termination = {
            ok: false,
            pid: child.pid,
            reason: "broker-launch-cleanup-failed",
            detail: error?.message || String(error),
        };
    }
    if (termination.ok) {
        ownedBrokerChildren.delete(child.pid);
        removeBrokerRuntime();
    }
    return termination;
}

export async function waitForBrokerOwnerResolve(host, port, timeoutMs) {
    const deadline = Date.now() + Math.max(1, timeoutMs);
    const attempts = [];
    let lastResult = null;
    let lastHttpFailure = null;
    while (Date.now() <= deadline) {
        const remainingMs = Math.max(1, deadline - Date.now());
        const resolved = await resolveBrokerOwner({
            hostCandidates: [host],
            port,
            timeoutMs: Math.min(1000, remainingMs),
        });
        lastResult = resolved;
        for (const attempt of resolved.attempts || []) {
            attempts.push(attempt);
            if (attempts.length > MAX_PROBE_CANDIDATES) attempts.shift();
            if (Number.isInteger(attempt?.status) && attempt.status >= 400) lastHttpFailure = attempt;
        }
        if (resolved.ok) return { ...resolved, attempts };
        if (Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, Math.min(100, remainingMs)));
    }
    return {
        ok: false,
        error: lastHttpFailure?.body?.error || lastResult?.error || "broker-owner-resolve-readiness-timeout",
        selected: lastResult?.selected || lastHttpFailure || null,
        attempts,
    };
}

async function replaceVerifiedOwnedLegacyBroker(runtime, port, statusBroker, options = {}) {
    const verified = verifiedOwnedLegacyBrokerProcess(
        runtime,
        port,
        statusBroker,
        options.portProcessResolver || discoverBrokerPortProcess,
    );
    if (!verified) return false;
    const termination = await terminateBrokerProcess(verified.pid, 3000, runtime.processStartToken);
    if (!termination.ok) return false;
    ownedBrokerChildren.delete(verified.pid);
    removeBrokerRuntime();
    return true;
}

async function ensureBroker(options = {}) {
    const owner = ownerId();
    const launch = normalizeLaunchOptions(options);
    const before = await probeBrokerHealth(launch);
    if (before.available) {
        const existingRuntime = readBrokerRuntime();
        const compatibility = await probeCccHostBrokerCapabilities(before.selected.host, before.selected.port, launch.timeoutMs);
        if (!compatibility.ok) {
            if (existingRuntime?.ownerId === owner && await replaceVerifiedOwnedLegacyBroker(
                existingRuntime,
                before.selected.port,
                compatibility.body?.broker,
                options,
            )) {
                return ensureBroker(options);
            }
            return {
                ok: false,
                ownerId: owner,
                launched: false,
                reused: false,
                error: "host-broker-incompatible",
                runtime: existingRuntime,
                host: before.selected.host,
                port: before.selected.port,
                compatibility,
                attempts: [...before.attempts, { reason: "host-broker-missing-required-capabilities", compatibility }],
            };
        }
        const ownerResolve = await resolveBrokerOwner({
            hostCandidates: [before.selected.host],
            port: before.selected.port,
            timeoutMs: launch.timeoutMs,
        });
        if (ownerResolve.ok) {
            const processVerification = reusableBrokerProcessVerification(
                existingRuntime,
                before.selected.port,
                before.selected.host,
                { statusBroker: compatibility.body?.broker },
            );
            if (!processVerification.ok) {
                return {
                    ok: false,
                    ownerId: owner,
                    launched: false,
                    reused: false,
                    error: "broker-runtime-process-unverified",
                    runtime: existingRuntime,
                    host: before.selected.host,
                    port: before.selected.port,
                    ownerResolve,
                    attempts: [...before.attempts, { reason: "broker-reuse-process-unverified", processVerification }],
                };
            }
            const verifiedRuntime = persistVerifiedBrokerRuntime(
                existingRuntime,
                processVerification,
                compatibility.body?.broker,
            );
            return {
                ok: true,
                ownerId: owner,
                launched: false,
                reused: true,
                runtime: verifiedRuntime,
                host: before.selected.host,
                port: before.selected.port,
                attempts: [
                    ...before.attempts,
                    { reason: "broker-reuse-process-verified", processVerification },
                    { reason: "broker-owner-resolve-ready", ownerResolve },
                ],
            };
        }
        const runtime = readBrokerRuntime();
        const attempts = [...before.attempts, { reason: "broker-owner-resolve-incompatible", ownerResolve }];
        if (
            runtime?.managedBy === "device-lab-mcp"
            && runtime.ownerId === owner
            && Number(runtime.port) === Number(before.selected.port)
            && pidAlive(runtime.pid)
        ) {
            const termination = await terminateVerifiedBrokerRuntime(runtime, 3000, {
                statusBroker: compatibility.body?.broker,
            });
            attempts.push({ reason: "incompatible-broker-termination", runtime, termination });
            if (!termination.ok) {
                return {
                    ok: false,
                    ownerId: owner,
                    launched: false,
                    reused: false,
                    error: termination.reason === "unverified-broker-port-process"
                        ? "broker-runtime-process-unverified"
                        : "broker-incompatible-process-still-running",
                    runtime,
                    host: before.selected.host,
                    port: before.selected.port,
                    ownerResolve,
                    attempts,
                };
            }
            ownedBrokerChildren.delete(runtime.pid);
            removeBrokerRuntime();
        } else {
            return {
                ok: false,
                ownerId: owner,
                launched: false,
                reused: false,
                error: ownerResolve.error || "broker-owner-resolve-unavailable",
                runtime,
                host: before.selected.host,
                port: before.selected.port,
                ownerResolve,
                attempts,
            };
        }
    }

    const existing = readBrokerRuntime();
    const stale = [];
    if (existing) {
        const existingPort = Number(existing.port);
        const runtimeTargetsRequestedPort = Number.isInteger(existingPort) && existingPort === Number(launch.port);
        if (existing.ownerId !== owner && runtimeTargetsRequestedPort) {
            return {
                ok: false,
                ownerId: owner,
                error: "runtime-owned-by-another-owner",
                runtime: existing,
                attempts: [...before.attempts, { reason: "runtime-owned-by-another-owner", runtime: existing }],
            };
        } else if (existing.ownerId !== owner) {
            stale.push({ reason: "runtime-ignored-for-different-owner-and-port", runtime: existing, requestedPort: launch.port });
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
                const compatibility = await probeCccHostBrokerCapabilities(existingProbe.selected.host, existingProbe.selected.port, launch.timeoutMs);
                if (!compatibility.ok) {
                    if (await replaceVerifiedOwnedLegacyBroker(
                        existing,
                        existingProbe.selected.port,
                        compatibility.body?.broker,
                        options,
                    )) {
                        return ensureBroker(options);
                    }
                    return {
                        ok: false,
                        ownerId: owner,
                        launched: false,
                        reused: false,
                        error: "host-broker-incompatible",
                        runtime: existing,
                        host: existingProbe.selected.host,
                        port: existingProbe.selected.port,
                        compatibility,
                        attempts: [...before.attempts, ...existingProbe.attempts, { reason: "host-broker-missing-required-capabilities", compatibility }],
                    };
                }
                const ownerResolve = await resolveBrokerOwner({
                    hostCandidates: [existingProbe.selected.host],
                    port: existingProbe.selected.port,
                    timeoutMs: launch.timeoutMs,
                });
                if (ownerResolve.ok) {
                    const processVerification = reusableBrokerProcessVerification(
                        existing,
                        existingProbe.selected.port,
                        existingProbe.selected.host,
                        { statusBroker: compatibility.body?.broker },
                    );
                    if (!processVerification.ok) {
                        return {
                            ok: false,
                            ownerId: owner,
                            launched: false,
                            reused: false,
                            error: "broker-runtime-process-unverified",
                            runtime: existing,
                            host: existingProbe.selected.host,
                            port: existingProbe.selected.port,
                            ownerResolve,
                            attempts: [
                                ...before.attempts,
                                ...existingProbe.attempts,
                                { reason: "broker-reuse-process-unverified", processVerification },
                            ],
                        };
                    }
                    const verifiedRuntime = persistVerifiedBrokerRuntime(
                        existing,
                        processVerification,
                        compatibility.body?.broker,
                    );
                    return {
                        ok: true,
                        ownerId: owner,
                        launched: false,
                        reused: true,
                        runtime: verifiedRuntime,
                        host: existingProbe.selected.host,
                        port: existingProbe.selected.port,
                        attempts: [
                            ...before.attempts,
                            ...existingProbe.attempts,
                            { reason: "broker-reuse-process-verified", processVerification },
                            { reason: "broker-owner-resolve-ready", ownerResolve },
                        ],
                    };
                }
                stale.push({ reason: "runtime-owner-resolve-incompatible", runtime: existing, attempts: existingProbe.attempts, ownerResolve });
                const termination = await terminateVerifiedBrokerRuntime(existing, 1500, {
                    statusBroker: compatibility.body?.broker,
                });
                stale.push({ reason: "runtime-owner-resolve-incompatible-termination", runtime: existing, termination });
                if (!termination.ok) {
                    return {
                        ok: false,
                        ownerId: owner,
                        error: "broker-runtime-process-unverified",
                        runtime: existing,
                        attempts: [...before.attempts, ...stale],
                    };
                }
                ownedBrokerChildren.delete(existing.pid);
                removeBrokerRuntime();
            } else {
                let recoveryStatusBroker = null;
                const recoveryProbe = await waitForBrokerHealth({
                    host: existing.host || launch.host,
                    port: existing.port || launch.port,
                    timeoutMs: launch.launchTimeoutMs,
                });
                if (recoveryProbe.available) {
                    const compatibility = await probeCccHostBrokerCapabilities(recoveryProbe.selected.host, recoveryProbe.selected.port, launch.timeoutMs);
                    recoveryStatusBroker = compatibility.body?.broker || null;
                    if (!compatibility.ok) {
                        if (await replaceVerifiedOwnedLegacyBroker(
                            existing,
                            recoveryProbe.selected.port,
                            compatibility.body?.broker,
                            options,
                        )) {
                            return ensureBroker(options);
                        }
                        return {
                            ok: false,
                            ownerId: owner,
                            launched: false,
                            reused: false,
                            error: "host-broker-incompatible",
                            runtime: existing,
                            host: recoveryProbe.selected.host,
                            port: recoveryProbe.selected.port,
                            compatibility,
                            attempts: [...before.attempts, ...existingProbe.attempts, ...recoveryProbe.attempts, { reason: "host-broker-missing-required-capabilities", compatibility }],
                        };
                    }
                    const ownerResolve = await resolveBrokerOwner({
                        hostCandidates: [recoveryProbe.selected.host],
                        port: recoveryProbe.selected.port,
                        timeoutMs: launch.timeoutMs,
                    });
                    if (ownerResolve.ok) {
                        const processVerification = reusableBrokerProcessVerification(
                            existing,
                            recoveryProbe.selected.port,
                            recoveryProbe.selected.host,
                            { statusBroker: compatibility.body?.broker },
                        );
                        if (!processVerification.ok) {
                            return {
                                ok: false,
                                ownerId: owner,
                                launched: false,
                                reused: false,
                                error: "broker-runtime-process-unverified",
                                runtime: existing,
                                host: recoveryProbe.selected.host,
                                port: recoveryProbe.selected.port,
                                ownerResolve,
                                attempts: [
                                    ...before.attempts,
                                    ...existingProbe.attempts,
                                    ...recoveryProbe.attempts,
                                    { reason: "broker-reuse-process-unverified", processVerification },
                                ],
                            };
                        }
                        const verifiedRuntime = persistVerifiedBrokerRuntime(
                            existing,
                            processVerification,
                            compatibility.body?.broker,
                        );
                        return {
                            ok: true,
                            ownerId: owner,
                            launched: false,
                            reused: true,
                            runtime: verifiedRuntime,
                            host: recoveryProbe.selected.host,
                            port: recoveryProbe.selected.port,
                            attempts: [
                                ...before.attempts,
                                ...existingProbe.attempts,
                                ...recoveryProbe.attempts,
                                { reason: "broker-reuse-process-verified", processVerification },
                                { reason: "broker-owner-resolve-ready", ownerResolve },
                            ],
                        };
                    }
                }
                const termination = await terminateVerifiedBrokerRuntime(existing, 3000, {
                    statusBroker: recoveryStatusBroker,
                });
                stale.push({
                    reason: "runtime-health-check-failed",
                    runtime: existing,
                    attempts: [...existingProbe.attempts, ...recoveryProbe.attempts],
                    termination,
                });
                if (!termination.ok) {
                    return {
                        ok: false,
                        ownerId: owner,
                        error: termination.reason === "unverified-broker-port-process"
                            ? "broker-runtime-process-unverified"
                            : "broker-unresponsive-process-still-running",
                        runtime: existing,
                        attempts: [...before.attempts, ...stale],
                    };
                }
                ownedBrokerChildren.delete(existing.pid);
                removeBrokerRuntime();
            }
        }
    }

    const startedAt = new Date().toISOString();
    let logPath = join(brokerLogsRoot(), `broker-${owner}-pending.log`);
    let logFd = null;
    let launchedChild = null;
    let launchedRuntime = null;
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
        const log = createBrokerLogFile(owner);
        logPath = log.path;
        logFd = log.descriptor;
        const child = spawn(launch.command, launch.args, {
            stdio: ["ignore", logFd, logFd],
            detached: false,
            windowsHide: true,
        });
        launchedChild = child;
        child.once("exit", () => {
            ownedBrokerChildren.delete(child.pid);
        });
        child.once("error", () => {
            ownedBrokerChildren.delete(child.pid);
        });
        let processStartToken = child.pid ? readBrokerProcessStartToken(child.pid) : null;
        for (let attempt = 0; child.pid && !processStartToken && attempt < 20; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 25));
            processStartToken = readBrokerProcessStartToken(child.pid);
        }
        if (child.pid) ownedBrokerChildren.set(child.pid, { child, processStartToken });
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
            processStartToken,
            managedBy: "device-lab-mcp",
        };
        launchedRuntime = runtime;
        writeBrokerRuntime(runtime);
        const ready = await waitForBrokerHealth({ host: launch.host, port: launch.port, timeoutMs: launch.launchTimeoutMs });
        if (ready.available) {
            const ownerResolve = await waitForBrokerOwnerResolve(launch.host, launch.port, launch.launchTimeoutMs);
            if (ownerResolve.ok) {
                const compatibility = await probeCccHostBrokerCapabilities(launch.host, launch.port, launch.timeoutMs);
                if (!compatibility.ok) {
                    const launchCleanup = await cleanupLaunchedBrokerRuntime(runtime, child, 3000);
                    return {
                        ok: false,
                        ownerId: owner,
                        launched: true,
                        reused: false,
                        error: "host-broker-incompatible",
                        runtime,
                        host: launch.host,
                        port: launch.port,
                        compatibility,
                        launchCleanup,
                        attempts: [
                            ...before.attempts,
                            ...stale,
                            ...ready.attempts,
                            { reason: "broker-launch-incompatible", compatibility },
                        ],
                    };
                }
                const launchProcessVerification = launchedBrokerProcessVerification(
                    runtime,
                    launch.port,
                    launch.host,
                    compatibility.body?.broker,
                );
                const processVerification = launchProcessVerification.verification;
                if (!processVerification.ok) {
                    const launchCleanup = await cleanupLaunchedBrokerRuntime(runtime, child, 3000);
                    return {
                        ok: false,
                        ownerId: owner,
                        launched: true,
                        reused: false,
                        error: "broker-runtime-process-unverified",
                        runtime,
                        host: launch.host,
                        port: launch.port,
                        launchCleanup,
                        attempts: [
                            ...before.attempts,
                            ...stale,
                            ...ready.attempts,
                            { reason: "broker-launch-process-unverified", processVerification },
                        ],
                    };
                }
                Object.assign(runtime, launchProcessVerification.runtime);
                writeBrokerRuntime(runtime);
                return {
                    ok: true,
                    ownerId: ownerResolve.ownerId,
                    launched: true,
                    reused: false,
                    runtime,
                    host: launch.host,
                    port: launch.port,
                    attempts: [
                        ...before.attempts,
                        ...stale,
                        ...ready.attempts,
                        { reason: "broker-launch-process-verified", processVerification },
                        { reason: "broker-owner-resolve-ready", ownerResolve },
                    ],
                };
            }
            const launchCleanup = await cleanupLaunchedBrokerRuntime(runtime, child, 3000);
            return {
                ok: false,
                ownerId: owner,
                error: "broker-launch-owner-resolve-timeout",
                detail: ownerResolve.selected
                    ? `${ownerResolve.error}: ${JSON.stringify(ownerResolve.selected)}`
                    : brokerLogTail(logPath) || `broker owner resolution did not become ready within ${launch.launchTimeoutMs}ms`,
                runtime,
                launchCleanup,
                ownerResolve,
                attempts: [...before.attempts, ...stale, ...ready.attempts, { reason: "broker-owner-resolve-readiness-timeout", ownerResolve }],
            };
        }
        const launchCleanup = await cleanupLaunchedBrokerRuntime(runtime, child, 1500);
        return {
            ok: false,
            ownerId: owner,
            error: "broker-launch-health-timeout",
            detail: brokerLogTail(logPath) || `broker did not become healthy within ${launch.launchTimeoutMs}ms`,
            runtime,
            launchCleanup,
            attempts: [...before.attempts, ...stale, ...ready.attempts],
        };
    } catch (error) {
        const launchCleanup = launchedRuntime && launchedChild
            ? await cleanupLaunchedBrokerRuntime(launchedRuntime, launchedChild, 1500)
            : (removeBrokerRuntime(), null);
        return {
            ok: false,
            ownerId: owner,
            error: "broker-launch-failed",
            detail: error?.message || String(error),
            command: launch.command,
            args: launch.args,
            logPath,
            ...(launchCleanup ? { launchCleanup } : {}),
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
    const status = await probeCccHostBrokerCapabilities(
        runtime.host || "127.0.0.1",
        Number(runtime.port) || 17373,
        options.timeoutMs || 1500,
    );
    const runtimeAlive = pidAlive(runtime.pid);
    if (!runtimeAlive) {
        ownedBrokerChildren.delete(runtime.pid);
        removeBrokerRuntime();
        return {
            ok: true,
            ownerId: owner,
            stopped: false,
            reason: "runtime-pid-not-alive",
            runtime,
        };
    }
    const verified = runtimeAlive
        ? verifiedBrokerProcess(
            runtime,
            Number(runtime.port),
            status.body?.broker || null,
        )
        : null;
    if (runtimeAlive && !verified) {
        return {
            ok: false,
            ownerId: owner,
            error: "broker-runtime-process-unverified",
            stopped: false,
            runtime,
        };
    }
    const cleanup = await brokerRpcRequest({
        method: "broker.cleanup.owner",
        params: {
            reason: "mcp-broker-shutdown",
            stopDevices: options.stopDevices !== false,
            detachPhysical: options.detachPhysical !== false,
        },
        hostCandidates: [runtime.host || "127.0.0.1"],
        port: runtime.port || 17373,
        timeoutMs: options.cleanupTimeoutMs || options.timeoutMs || 1500,
        verifyBeforeAuthenticatedRequest: () => {
            const current = verifiedBrokerProcess(
                runtime,
                Number(runtime.port),
                status.body?.broker || null,
            );
            return Boolean(
                current
                && current.pid === verified?.pid
                && current.processStartToken
                && current.processStartToken === (verified?.processStartToken || runtime.processStartToken),
            );
        },
    });
    let signaled = false;
    if (runtimeAlive && verified) {
        try {
            const termination = await terminateBrokerProcess(
                verified.pid,
                options.force === true ? 500 : 1500,
                verified.processStartToken || runtime.processStartToken || null,
            );
            if (!termination.ok) {
                return {
                    ok: false,
                    ownerId: owner,
                    error: termination.reason || "broker-shutdown-timeout",
                    stopped: false,
                    runtime,
                    cleanup,
                };
            }
            signaled = true;
        } catch (error) {
            return { ok: false, ownerId: owner, error: "broker-shutdown-failed", detail: error?.message || String(error), runtime, cleanup };
        }
    }
    ownedBrokerChildren.delete(runtime.pid);
    removeBrokerRuntime();
    const cleanupOk = cleanup.ok === true && cleanup.result?.failed !== undefined
        ? cleanup.result.failed === 0
        : cleanup.ok === true;
    return {
        ok: cleanupOk,
        ownerId: owner,
        ...(cleanupOk ? {} : { error: "broker-owner-cleanup-failed" }),
        stopped: signaled,
        runtime,
        cleanup,
    };
}

function brokerAuthSecretFile(owner) {
    if (!/^[a-f0-9]{16}$/.test(owner)) throw new Error("invalid-owner-id");
    const isolatedFile = String(process.env.CCC_DEVICE_BROKER_AUTH_FILE || "").trim();
    if (isolatedFile) return resolve(isolatedFile);
    return join(brokerStateRoot(), "broker", "auth", `${owner}.json`);
}

function brokerAuthDirectoryValid() {
    const isolatedFile = String(process.env.CCC_DEVICE_BROKER_AUTH_FILE || "").trim();
    if (isolatedFile) {
        try {
            const stat = lstatSync(dirname(resolve(isolatedFile)));
            return stat.isDirectory() && !stat.isSymbolicLink();
        } catch {
            return false;
        }
    }
    const root = brokerStateRoot();
    for (const directory of [root, join(root, "broker"), join(root, "broker", "auth")]) {
        try {
            const stat = lstatSync(directory);
            if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
        } catch {
            return false;
        }
    }
    return true;
}

function readBoundedUtf8Descriptor(descriptor, limitBytes) {
    const buffer = Buffer.allocUnsafe(limitBytes + 1);
    let total = 0;
    while (total <= limitBytes) {
        const count = readSync(descriptor, buffer, total, buffer.length - total, null);
        if (count === 0) return buffer.subarray(0, total).toString("utf8");
        total += count;
    }
    throw new Error("control-state-file-too-large");
}

function existingOwnerSecret(owner) {
    if (!brokerAuthDirectoryValid()) return null;
    const file = brokerAuthSecretFile(owner);
    let fd = null;
    try {
        const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
        fd = openSync(file, fsConstants.O_RDONLY | noFollow);
        const stat = fstatSync(fd);
        const pathStat = lstatSync(file);
        if (!stat.isFile() || !pathStat.isFile() || pathStat.isSymbolicLink() || stat.nlink !== 1
            || stat.dev !== pathStat.dev || stat.ino !== pathStat.ino) return null;
        if (stat.size > BROKER_AUTH_FILE_LIMIT_BYTES) return null;
        const parsed = JSON.parse(readBoundedUtf8Descriptor(fd, BROKER_AUTH_FILE_LIMIT_BYTES));
        if (parsed?.ownerId !== owner || typeof parsed?.secret !== "string" || !/^[a-f0-9]{64}$/.test(parsed.secret)) return null;
        return parsed.secret;
    } catch {
        return null;
    } finally {
        if (fd !== null) {
            try { closeSync(fd); } catch { /* best effort after a read failure */ }
        }
    }
}

function ownerToken(owner) {
    const secret = existingOwnerSecret(owner);
    return secret
        ? createHash("sha256").update(`${BROKER_NAME}:owner:${owner}:secret:${secret}`).digest("hex")
        : null;
}

async function resolveBrokerOwner(probeOptions) {
    const attempts = [];
    const requestBody = JSON.stringify({
        projectMountPath: projectMountPath(),
        profile: process.env.CCC_PROFILE || null,
    });
    for (const host of probeOptions.hostCandidates) {
        const endpoint = `http://${host}:${probeOptions.port}/v1/owner/resolve`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), probeOptions.timeoutMs);
        const startedAt = Date.now();
        try {
            const response = await fetch(endpoint, {
                method: "POST",
                signal: controller.signal,
                redirect: "manual",
                headers: { "content-type": "application/json" },
                body: requestBody,
            });
            const responseBody = await readBrokerHttpJson(response, BROKER_CONTROL_RESPONSE_LIMIT_BYTES);
            const body = responseBody.body;
            const attempt = {
                host,
                port: probeOptions.port,
                endpoint,
                ok: responseBody.ok && response.ok,
                status: response.status,
                durationMs: Date.now() - startedAt,
                body: summarizeBody(body),
                ...(responseBody.ok ? {} : { error: responseBody.error, maxBytes: responseBody.maxBytes }),
            };
            attempts.push(attempt);
            if (!responseBody.ok) return { ok: false, error: responseBody.error, selected: attempt, attempts };
            const resolvedOwnerId = body?.result?.ownerId;
            if (response.ok && typeof resolvedOwnerId === "string" && /^[a-f0-9]{16}$/.test(resolvedOwnerId)) {
                return { ok: true, ownerId: resolvedOwnerId, selected: attempt, attempts };
            }
            if (response.status !== 404 && response.status !== 405) return { ok: false, error: body?.error || "broker-owner-resolve-failed", selected: attempt, attempts };
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
    return { ok: false, error: "broker-owner-resolve-unavailable", selected: null, attempts };
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

async function verifyAuthenticatedBrokerGeneration(host, port, launch, options) {
    if (typeof options.verifyBeforeAuthenticatedRequest === "function"
        && options.verifyBeforeAuthenticatedRequest() !== true) {
        return null;
    }
    if (process.env.NODE_ENV === "test"
        && (process.env.CCC_DEVICE_LAB_TEST_ALLOW_UNVERIFIED_BROKER === "1"
            || options.autolaunch === false)) {
        return { ...(launch?.runtime || readBrokerRuntime() || {}), testOnly: true };
    }
    const attestationTimeoutMs = Number.isFinite(Number(options.timeoutMs))
        ? Math.min(5000, Math.max(1, Number(options.timeoutMs)))
        : 5000;
    const attestation = await probeCccHostBrokerCapabilities(host, port, attestationTimeoutMs);
    const broker = attestation?.body?.broker;
    const brokerPid = Number(broker?.process?.pid);
    const brokerStartToken = typeof broker?.process?.startToken === "string" ? broker.process.startToken : "";
    const brokerStartedAt = typeof broker?.startedAt === "string" ? broker.startedAt : "";
    if (!attestation.ok || !Number.isInteger(brokerPid) || brokerPid <= 0 || !brokerStartToken || !brokerStartedAt) return null;
    const runtime = launch?.runtime || readBrokerRuntime();
    if (!runtime || (
        Number(runtime.port) !== Number(port)
        || Number(runtime.pid) !== brokerPid
        || runtime.processStartToken !== brokerStartToken
        || runtime.startedAt !== brokerStartedAt
    )) return null;
    const normalizedHost = String(host || "").trim().toLowerCase();
    const loopback = normalizedHost === "127.0.0.1" || normalizedHost === "localhost" || normalizedHost === "::1";
    if (!loopback) return runtime;
    return verifiedBrokerProcess(runtime, Number(port), broker) ? runtime : null;
}

export const verifyAuthenticatedBrokerGenerationForTest = verifyAuthenticatedBrokerGeneration;

function authenticatedBrokerHeaders(token, owner, runtime, body) {
    if (runtime.testOnly === true && process.env.NODE_ENV === "test") {
        return { "x-ccc-device-token": token };
    }
    const timestamp = String(Date.now());
    const nonce = randomBytes(16).toString("hex");
    const bodyHash = createHash("sha256").update(body).digest("hex");
    const payload = [
        "v1",
        owner,
        timestamp,
        nonce,
        runtime.startedAt,
        runtime.processStartToken,
        bodyHash,
    ].join("\n");
    return {
        "x-ccc-device-auth": createHmac("sha256", token).update(payload).digest("hex"),
        "x-ccc-device-auth-timestamp": timestamp,
        "x-ccc-device-auth-nonce": nonce,
        "x-ccc-device-broker-started-at": runtime.startedAt,
        "x-ccc-device-broker-start-token": runtime.processStartToken,
    };
}

export const authenticatedBrokerHeadersForTest = authenticatedBrokerHeaders;

async function brokerRpcRequest(options = {}) {
    let owner = ownerId();
    const requestedHosts = Array.isArray(options.hostCandidates) ? options.hostCandidates.map(String) : [];
    const untrustedHost = requestedHosts.find((host) => !TRUSTED_BROKER_HOSTS.has(host));
    const untrustedLaunchHost = typeof options.launchHost === "string" && options.launchHost
        && !TRUSTED_BROKER_HOSTS.has(options.launchHost)
        ? options.launchHost
        : null;
    if (untrustedHost || untrustedLaunchHost) {
        return {
            ok: false,
            ownerId: owner,
            error: "invalid-broker-host-candidate",
            host: untrustedHost || untrustedLaunchHost,
            allowed: [...TRUSTED_BROKER_HOSTS],
            attempts: [],
        };
    }
    let probeOptions = normalizeProbeOptions({ ...options, probe: true });
    const rpcTimeoutMs = normalizeRpcTimeoutMs(options, probeOptions.timeoutMs);
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
        if (typeof launch.host !== "string" || !TRUSTED_BROKER_HOSTS.has(launch.host)) {
            return {
                ok: false,
                ownerId: owner,
                method,
                selected: null,
                error: "invalid-broker-host-candidate",
                host: launch.host ?? null,
                allowed: [...TRUSTED_BROKER_HOSTS],
                launch,
                attempts: launch.attempts || [],
            };
        }
        probeOptions = { ...probeOptions, hostCandidates: [launch.host], port: launch.port };
    }
    let requestBody = JSON.stringify({
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
    const resolvedOwner = await resolveBrokerOwner(probeOptions);
    if (resolvedOwner.ok) owner = resolvedOwner.ownerId;
    else {
        const brokerUnavailable = resolvedOwner.error === "broker-owner-resolve-unavailable"
            && (resolvedOwner.attempts || []).some((attempt) => attempt.status === null);
        return {
            ok: false,
            ownerId: owner,
            method,
            selected: resolvedOwner.selected || null,
            error: brokerUnavailable ? "broker-rpc-unavailable" : resolvedOwner.error || "broker-owner-resolve-failed",
            ownerResolve: resolvedOwner,
            attempts: resolvedOwner.attempts || [],
        };
    }
    requestBody = JSON.stringify({
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

    const token = ownerToken(owner);
    if (!token) {
        return {
            ok: false,
            ownerId: owner,
            method,
            selected: resolvedOwner.selected || null,
            error: "broker-owner-auth-unavailable",
            ownerResolve: resolvedOwner,
            attempts: resolvedOwner.attempts || [],
        };
    }

    const attempts = [];
    for (const host of probeOptions.hostCandidates) {
        const rpcPath = `/v1/owners/${encodeURIComponent(owner)}/rpc`;
        const endpoint = `http://${host}:${probeOptions.port}${rpcPath}`;
        const startedAt = Date.now();
        try {
            const verifiedRuntime = await verifyAuthenticatedBrokerGeneration(host, probeOptions.port, launch, options);
            if (!verifiedRuntime) {
                return {
                    ok: false,
                    ownerId: owner,
                    method,
                    selected: null,
                    error: "broker-runtime-process-unverified",
                    ownerResolve: resolvedOwner,
                    attempts,
                };
            }
            const response = await brokerRpcHttpJsonRequest({
                host,
                port: probeOptions.port,
                path: rpcPath,
                timeoutMs: rpcTimeoutMs,
                maxBytes: BROKER_RPC_RESPONSE_LIMIT_BYTES,
                headers: {
                    "content-type": "application/json",
                    ...authenticatedBrokerHeaders(token, owner, verifiedRuntime, requestBody),
                },
                body: requestBody,
            });
            const responseBody = response.responseBody;
            const body = responseBody.body;
            const attempt = {
                host,
                port: probeOptions.port,
                endpoint,
                ok: responseBody.ok && response.ok,
                status: response.status,
                durationMs: Date.now() - startedAt,
                timeoutMs: rpcTimeoutMs,
                body: summarizeBody(body),
                ...(responseBody.ok ? {} : { error: responseBody.error, maxBytes: responseBody.maxBytes }),
            };
            attempts.push(attempt);
            if (!responseBody.ok) {
                return {
                    ok: false,
                    ownerId: owner,
                    method,
                    selected: attempt,
                    error: responseBody.error,
                    status: response.status,
                    body: summarizeBody(body),
                    launch,
                    attempts,
                };
            }
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
            const failure = brokerTransportFailure(error);
            attempts.push({
                host,
                port: probeOptions.port,
                endpoint,
                ok: false,
                status: null,
                durationMs: Date.now() - startedAt,
                timeoutMs: rpcTimeoutMs,
                error: failure.error,
                transportCode: failure.transportCode,
                transportRetryable: failure.retryable,
            });
        }
    }
    if (hyperVCreateTransportRetryEligible(options, method, attempts)) {
        const initial = summarizeBrokerTransportFailure(attempts, launch);
        await new Promise((resolve) => setTimeout(resolve, 250));
        const retried = await brokerRpcRequest({
            ...options,
            hostCandidates: [initial.host],
            port: initial.port,
            __hyperVCreateTransportRetryAttempted: true,
        });
        return {
            ...retried,
            attempts: [...attempts, ...(Array.isArray(retried.attempts) ? retried.attempts : [])],
            transportRecovery: {
                attempted: true,
                recovered: retried.ok === true,
                initial,
                ...(retried.ok === true
                    ? {}
                    : { retry: summarizeBrokerTransportFailure(retried.attempts || [], retried.launch) }),
            },
        };
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
        heartbeat: "broker.lease.heartbeat",
        prune: "broker.lease.prune",
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
            ttlMs: options.ttlMs,
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

export async function brokerApple(options = {}) {
    const action = typeof options.action === "string" ? options.action : "status";
    return brokerRpcRequest({
        ...options,
        method: "broker.apple.trust",
        params: {
            action,
            backend: options.backend || "ios-device",
            udid: options.udid,
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
    const lifecycleTimeoutMs = action === "invoke" && options.dryRun !== true && !Number.isFinite(options.timeoutMs)
        ? DEFAULT_LIFECYCLE_RPC_TIMEOUT_MS
        : options.timeoutMs;
    return brokerRpcRequest({
        ...options,
        ...(Number.isFinite(lifecycleTimeoutMs) ? { timeoutMs: lifecycleTimeoutMs } : {}),
        method,
        params: {
            ...plainObject(options.options),
            backend: options.backend,
            command: options.command,
            deviceId: options.deviceId,
            incarnationId: options.incarnationId,
            name: options.name,
            avdName: options.avdName,
            port: options.devicePort,
            systemImage: options.systemImage,
            deviceProfile: options.deviceProfile,
            createAvd: options.createAvd,
            headless: options.headless,
            minimized: options.minimized,
            simulatorName: options.simulatorName,
            deviceType: options.deviceType,
            runtime: options.runtime,
            udid: options.udid,
            createSimulator: options.createSimulator,
            networking: options.networking,
            clipboard: options.clipboard,
            vgpu: options.vgpu,
            memoryMb: options.memoryMb,
            provider: options.provider,
            image: options.image,
            sourceImage: options.sourceImage,
            profile: options.profile,
            switchName: options.switchName,
            secureBootTemplate: options.secureBootTemplate,
            baseImageId: options.baseImageId,
            cpus: options.cpus,
            sshHost: options.sshHost,
            sshPort: options.sshPort,
            sshUser: options.sshUser,
            sshKeyPath: options.sshKeyPath,
            sshPassword: options.sshPassword,
            guestSshHost: options.guestSshHost,
            guestSshPort: options.guestSshPort,
            guestSshUser: options.guestSshUser,
            guestSshKeyPath: options.guestSshKeyPath,
            guestReadinessCommand: options.guestReadinessCommand,
            guestAgentName: options.guestAgentName,
            guestAgentHealthCommand: options.guestAgentHealthCommand,
            guestAgentProvisionCommand: options.guestAgentProvisionCommand,
            guestAgentAutoProvision: options.guestAgentAutoProvision,
            startIfStopped: options.startIfStopped,
            waitForBoot: options.waitForBoot,
            bootTimeoutMs: options.bootTimeoutMs,
            force: options.force,
            deleteAvd: options.deleteAvd,
            deleteSimulator: options.deleteSimulator,
            dryRun: options.dryRun,
        },
    });
}

export const BROKER_DEVICE_TOOL_PARAM_KEYS = [
    "backend",
    "action",
    "serial",
    "host",
    "port",
    "pairHost",
    "pairPort",
    "pairingCode",
    "connect",
    "deviceId",
    "incarnationId",
    "command",
    "localPath",
    "remotePath",
    "path",
    "dryRun",
    "replace",
    "maxFiles",
    "maxFileBytes",
    "maxTotalBytes",
    "packageName",
    "component",
    "bundleId",
    "containerType",
    "snapshotName",
    "snapshotId",
    "force",
    "eraseSimulator",
    "confirmDestructive",
    "x",
    "y",
    "x1",
    "y1",
    "x2",
    "y2",
    "button",
    "key",
    "keyCode",
    "text",
    "direction",
    "amount",
    "durationMs",
    "orientation",
    "url",
    "permission",
    "service",
    "latitude",
    "longitude",
    "altitude",
    "level",
    "charging",
    "status",
    "wifi",
    "data",
    "enabled",
    "timeoutMs",
    "intervalMs",
    "appiumPort",
    "serverPort",
    "automationName",
    "provider",
    "physical",
    "helperTimeoutMs",
    "maxDepth",
    "maxNodes",
    "timeLimitSec",
];

function brokerDeviceToolParams(tool, options = {}) {
    return {
        tool,
        ...Object.fromEntries(BROKER_DEVICE_TOOL_PARAM_KEYS.map((key) => [
            key,
            key === "port" && Number.isInteger(options.devicePort) ? options.devicePort : options[key],
        ])),
    };
}

export async function brokerDeviceTool(options = {}) {
    const tool = typeof options.tool === "string" ? options.tool : "";
    if (!tool) {
        return {
            ok: false,
            ownerId: ownerId(),
            error: "missing-device-tool",
            attempts: [],
        };
    }
    return brokerRpcRequest({
        ...options,
        method: "broker.device.tool.invoke",
        params: brokerDeviceToolParams(tool, options),
    });
}

export async function brokerAppium(options = {}) {
    const action = typeof options.action === "string" ? options.action : "";
    const methodByAction = {
        status: "broker.appium.status",
        list: "broker.appium.list",
        record: "broker.appium.record",
        clear: "broker.appium.clear",
        start: "broker.appium.start",
        stop: "broker.appium.stop",
        "ensure-session": "broker.appium.session.ensure",
        "delete-session": "broker.appium.session.delete",
        request: "broker.appium.request",
    };
    const method = methodByAction[action];
    if (!method) {
        return {
            ok: false,
            ownerId: ownerId(),
            error: "invalid-appium-action",
            allowed: Object.keys(methodByAction),
            attempts: [],
        };
    }
    return brokerRpcRequest({
        ...options,
        method,
        params: {
            backend: options.backend,
            deviceId: options.deviceId,
            appium: options.appium,
            serverUrl: options.serverUrl,
            sessionId: options.sessionId,
            serverPid: options.serverPid,
            port: options.appiumPort ?? options.serverPort,
            automationName: options.automationName,
            provider: options.provider,
            physical: options.physical,
            force: options.force,
            method: options.method,
            path: options.path,
            body: options.body,
        },
    });
}

export async function brokerStatus(options = {}) {
    const owner = ownerId();
    const root = brokerStateRoot();
    const hasExplicitTransport = Array.isArray(options.hostCandidates) || Number.isInteger(options.port);
    const implicitProbe = hasExplicitTransport ? null : implicitBrokerProbeOptions(options, { allowDefault: true });
    const statusOptions = implicitProbe ? { ...options, ...implicitProbe } : options;
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
    if (statusOptions.probe !== false && statusOptions.autolaunch !== false) {
        launch = await ensureBroker(statusOptions);
    }
    const probeOptions = normalizeProbeOptions({ ...statusOptions, probe: statusOptions.probe !== false });
    const effectiveProbeOptions = launch?.ok ? { ...probeOptions, probe: true, hostCandidates: [launch.host], port: launch.port } : probeOptions;
    const probe = effectiveProbeOptions.probe
        ? await probeBrokerHealth(effectiveProbeOptions)
        : { requested: false, available: false, selected: null, attempts: [] };
    const ownerResolve = probe.available
        ? await resolveBrokerOwner(effectiveProbeOptions)
        : { ok: false, error: "broker-unavailable", selected: null, attempts: [] };
    const ownerResolveWarning = probe.available && !ownerResolve.ok
        ? "host broker is reachable but does not satisfy the required owner-resolve contract; restart or upgrade the host broker so /v1/owner/resolve is available"
        : null;
    const ownerResolveRemedy = ownerResolveWarning
        ? "Restart the host ccc device broker from the host using the same checkout/version as this container, then rerun device_broker_status."
        : null;
    const runtime = readBrokerRuntime();
    const containerContract = brokerContainerContract();
    const launchIncompatible = launch?.error === "host-broker-incompatible";
    const compatibilityWarning = launchIncompatible
        ? `host broker is reachable but missing required capabilities: ${(launch.compatibility?.missingCapabilities || []).join(", ") || "unknown"}`
        : null;
    const warnings = [...containerContract.warnings, ...(ownerResolveWarning ? [ownerResolveWarning] : []), ...(compatibilityWarning ? [compatibilityWarning] : [])];
    const remedies = [...containerContract.remedies, ...(ownerResolveRemedy ? [ownerResolveRemedy] : []), ...(compatibilityWarning ? ["Restart or upgrade the host ccc device broker before using host-backed tools."] : [])];
    return {
        ownerId: owner,
        mode: launchIncompatible ? "broker-incompatible" : probe.available ? "host-broker-detected" : "broker-unavailable",
        lazy: true,
        available: probe.available && !launchIncompatible,
        rpcReady: ownerResolve.ok && !launchIncompatible,
        startupPolicy: "device-lab MCP requires the host broker for host-backed providers; status/backend discovery may start or reuse the broker but never starts devices",
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
        ownerResolve,
        launch,
        runtime,
        state: {
            root,
            ownerRoot: join(root, "owners", owner),
            locksRoot: join(root, "broker", "locks"),
            logsRoot: join(root, "broker", "logs"),
            runtimeFile: brokerRuntimeFile(),
            rootExists: containerContract.stateExists,
        },
        containerContract,
        warnings,
        remedies,
        persistence: brokerPersistence(owner),
        implemented: [
            "owner-scoped direct provider adapters",
            "owner-scoped state layout",
            "physical device lease files",
            "explicit cross-project CLI cleanup commands",
            "broker contract inspection",
            "broker health probe",
            "explicit broker RPC diagnostic transport",
            "explicit broker physical lease diagnostics",
            "explicit broker Apple trust and network-pairing diagnostics",
            "explicit broker lifecycle command dry-run diagnostics",
            "implicit broker lifecycle routing for reachable broker devices",
            "broker read-only device inventory and recording status routing",
            "explicit broker recording start/stop routing",
            "broker desktop device tool result proxying",
            "host broker service manager diagnostics",
            "explicit broker Appium process/session/request routing",
            "opt-in high-level mobile broker Appium routing",
            "host ccc auto-started broker discovery",
            "explicit MCP broker autolaunch compatibility",
            "mcp-owned broker shutdown",
            "broker runtime pid metadata",
            "secret-backed broker owner token auth",
            "cross-process device operation serialization",
            "cross-process device runtime serialization",
        ],
        deferred: [],
        note: "Device backends remain lazy. Host ccc starts only the broker process for containers; it does not start emulators, simulators, sandboxes, VMs, Appium, or provider tools.",
    };
}
