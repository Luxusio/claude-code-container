import { readBrokerOwnerSecret } from "@ccc/device-lab/providers/state/broker-owner-secret.mjs";
import { createBrokerSupervision } from "./application/broker-supervision.mjs";
import { supervisionErrorDetail } from "./domain/broker-supervision.mjs";
import { isBrokerMacosTartImageCreate, brokerMacosTartCreateRpcTimeoutMs, BROKER_MACOS_TART_CREATE_TIMEOUT_MS } from "@ccc/device-lab/device-lab/domain/lifecycle/macos-vm-lifecycle.js";
import { fileURLToPath } from "url";
import { createWaitBudget } from "@ccc/device-lab/providers/wait-budget.mjs";
import { AsyncLocalStorage } from "async_hooks";
import { createHash, createHmac, randomBytes } from "crypto";
import { spawn, spawnSync } from "child_process";
import { accessSync, closeSync, constants as fsConstants, existsSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, unlinkSync } from "fs";
import { request as httpRequest } from "http";
import { homedir } from "os";
import { delimiter, dirname, join, resolve } from "path";
import { performance } from "node:perf_hooks";
import { ownerBasis, ownerId, PACKAGE_ROOT, projectMountPath } from "@ccc/device-lab/providers/context.mjs";
import { DEVICE_BROKER_PROTOCOL_VERSION, isCompatibleBrokerProtocol } from "@ccc/device-lab/providers/contracts/broker-protocol.mjs";
import { configuredDeviceBrokerPort, deviceBrokerRuntimeFilename } from "@ccc/device-lab/providers/contracts/broker-endpoint.mjs";
import { isDeepStrictEqual } from "node:util";
import { withSharedMutationLock, writeJsonFileAtomically } from "@ccc/device-lab/providers/state/shared-mutation-lock.mjs";
import { readDeviceLabStateFile } from "@ccc/device-lab/providers/state/state-file.mjs";
import { canonicalWindowsPowerShellPath, canonicalWindowsSystemExecutablePath, hiddenWindowsPowerShellArgs, terminateWindowsProcessByStartToken } from "@ccc/device-lab/providers/state/windows-system-powershell.mjs";

const brokerOperations = new AsyncLocalStorage();
const brokerEndpoints = new AsyncLocalStorage();
const brokerSetupEvidence = new WeakMap();
const localObservationBudgetExhaustions = new WeakSet();

export function isLocalObservationBudgetExhaustion(result) {
    return localObservationBudgetExhaustions.has(result);
}

export function withBrokerOperation(callback) {
    const operation = { setups: new Map() };
    return brokerOperations.run(operation, async () => {
        try {
            return await callback();
        } finally {
            operation.setups = null;
        }
    });
}

function invalidateBrokerSetup() {
    const operation = brokerOperations.getStore();
    if (operation?.setups) operation.setups = new Map();
}

function withSetupEvidence(result, health, ownerResolve) {
    brokerSetupEvidence.set(result, { health, ownerResolve });
    return result;
}

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
const DEFAULT_LIFECYCLE_RPC_TIMEOUT_MS = 120000;
const MAX_RPC_TIMEOUT_MS = 21615000;
const MAX_RPC_BODY_BYTES = 64 * 1024;
export const BROKER_CONTROL_RESPONSE_LIMIT_BYTES = 1024 * 1024;
export const BROKER_RPC_RESPONSE_LIMIT_BYTES = 64 * 1024 * 1024;
export const BROKER_RPC_SCREENSHOT_RESPONSE_LIMIT_BYTES = 8 * 1024 * 1024;
const BROKER_INVALID_RESPONSE_RAW_LIMIT_BYTES = 32 * 1024;
const BROKER_RUNTIME_FILE_LIMIT_BYTES = 64 * 1024;
const BROKER_LOG_TAIL_READ_LIMIT_BYTES = 4 * 1024;
const BROKER_NAME = "ccc-device-broker";
const PUBLIC_BROKER_RPC_METHODS = new Set(["broker.status", "broker.inventory", "broker.backends", "broker.echo"]);
const MAX_LAUNCH_TIMEOUT_MS = 15000;
const ownedBrokerChildren = new Map();
let cleanupRegistered = false;
let exitingFromSignal = false;

// Keep this Tart caller's allowance alongside the existing operation setup cache.
function macosCreateTimeoutMs(timeoutMs) {
    const remaining = brokerOperations.getStore()?.macosCreateRemainingMs;
    return remaining ? Math.max(0, Math.min(timeoutMs, Math.floor(remaining()))) : timeoutMs;
}

function assertMacosCreateAllowance() {
    if (macosCreateTimeoutMs(Infinity) < 1) {
        throw Object.assign(new Error("macos-tart-create-budget-exhausted"), {code: "macos-tart-create-budget-exhausted"});
    }
}

const brokerSupervision = createBrokerSupervision({
    protocolVersion: DEVICE_BROKER_PROTOCOL_VERSION,
    ownerId, normalizeLaunchOptions, probeBrokerHealth, readBrokerRuntime, probeCccHostBrokerProtocol,
    resolveBrokerOwner, reusableBrokerProcessVerification, persistVerifiedBrokerRuntime, withSetupEvidence,
    pidAlive, terminateVerifiedBrokerRuntime, removeBrokerRuntime, waitForBrokerHealth,
    waitForBrokerOwnerResolve, launchOwnedBroker, readBrokerProcessStartToken,
    terminateBrokerProcess, waitForProcessExit, writeBrokerRuntime, launchedBrokerProcessVerification,
    cleanupLaunchedBrokerRuntime, brokerLogTail, verifiedBrokerProcess, invalidateBrokerSetup,
    verifiedOwnedLegacyBrokerProcess: (runtime, port, status, resolver) => verifiedOwnedLegacyBrokerProcess(runtime, port, status, resolver || discoverBrokerPortProcess),
    currentOperation: () => brokerOperations.getStore(),
    setupCacheKey: options => JSON.stringify([normalizeLaunchOptions(options), ownerId(), ownerBasis(), projectMountPath(), brokerRuntimeFile()]),
    ownedChildrenEntries: () => {
        const endpoint = brokerEndpoints.getStore();
        return [...ownedBrokerChildren.entries()].filter(([, owned]) => !endpoint
            || (owned.endpoint.runtimeFilename === endpoint.runtimeFilename && owned.endpoint.port === endpoint.port));
    },
    deleteOwnedChild: pid => { ownedBrokerChildren.delete(pid); },
    signalChild: (child, signal) => { child.kill?.(signal); },
    cleanupOwner: (runtime, params, timeoutMs, statusBroker, verified) => brokerRpcRequest({
        method: "broker.cleanup.owner", params,
        hostCandidates: [runtime.host || "127.0.0.1"], port: runtime.port || 17373, timeoutMs,
        verifyBeforeAuthenticatedRequest: () => {
            const current = verifiedBrokerProcess(runtime, Number(runtime.port), statusBroker);
            return Boolean(current && current.pid === verified?.pid && current.processStartToken
                && current.processStartToken === (verified?.processStartToken || runtime.processStartToken));
        },
    }),
});


function brokerStateRoot() {
    return join(homedir(), ".ccc/devices");
}

function selectedBrokerEndpoint(options = {}) {
    const inherited = brokerEndpoints.getStore();
    const configuredPort = inherited ? (inherited.configured ? inherited.port : undefined) : configuredDeviceBrokerPort();
    const port = Number.isInteger(options.port) ? Number(options.port) : configuredPort ?? 17373;
    return {
        configured: configuredPort !== undefined,
        port,
        runtimeFilename: deviceBrokerRuntimeFilename(configuredPort === undefined ? {} : { CCC_DEVICE_BROKER_PORT: String(port) }),
    };
}

function withBrokerEndpoint(options, callback) {
    return brokerEndpoints.run(selectedBrokerEndpoint(options), callback);
}

function brokerRuntimeFile() {
    const endpoint = brokerEndpoints.getStore() || selectedBrokerEndpoint();
    return join(brokerStateRoot(), "broker", endpoint.runtimeFilename);
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

/** @param {string} owner @param {import('./domain/broker-supervision.mjs').BrokerLaunch} launch
 * @returns {Promise<import('./domain/broker-supervision.mjs').BrokerLaunchResult>}
 */
async function launchOwnedBroker(owner, launch) {
    const startedAt = new Date().toISOString();
    const diagnostics = {
        command: launch.command,
        args: launch.args,
        logPath: join(brokerLogsRoot(), `broker-${owner}-pending.log`),
    };
    /** @type {number|null} */
    let descriptor = null;
    /** @type {import('./domain/broker-supervision.mjs').BrokerRuntime|null} */
    let runtime = null;
    try {
        assertMacosCreateAllowance();
        if (!executableExists(launch.command)) {
            return { kind: "failed", runtime, detail: "executable-not-found", diagnostics };
        }
        const log = createBrokerLogFile(owner);
        descriptor = log.descriptor;
        diagnostics.logPath = log.path;
        assertMacosCreateAllowance();
        const endpoint = brokerEndpoints.getStore() || selectedBrokerEndpoint();
        const child = spawn(launch.command, launch.args, {
            stdio: ["ignore", descriptor, descriptor], detached: false, windowsHide: true,
            env: { ...process.env, CCC_DEVICE_BROKER_PORT: endpoint.configured ? String(endpoint.port) : undefined },
        });
        runtime = {
            name: BROKER_NAME,
            ownerId: owner,
            pid: child.pid || null,
            host: launch.host,
            port: launch.port,
            command: launch.command,
            args: launch.args,
            logPath: log.path,
            startedAt,
            processStartToken: null,
            managedBy: "device-lab-mcp",
        };
        const owned = { child, endpoint, processStartToken: /** @type {string|null} */ (null) };
        const pid = runtime.pid;
        if (pid) ownedBrokerChildren.set(pid, owned);
        const retireChild = () => {
            if (ownedBrokerChildren.get(pid) === owned) ownedBrokerChildren.delete(pid);
        };
        child.once("exit", retireChild);
        child.once("error", retireChild);
        runtime.processStartToken = pid && ownedBrokerChildren.get(pid) === owned ? readBrokerProcessStartToken(pid) : null;
        owned.processStartToken = runtime.processStartToken;
        for (let attempt = 0; pid && !runtime.processStartToken && attempt < 20; attempt += 1) {
            const delay = macosCreateTimeoutMs(25);
            if (delay < 1) break;
            await new Promise(resolve => setTimeout(resolve, delay));
            if (macosCreateTimeoutMs(Infinity) < 1) break;
            if (ownedBrokerChildren.get(pid) !== owned) break;
            runtime.processStartToken = readBrokerProcessStartToken(pid);
            owned.processStartToken = runtime.processStartToken;
        }
        registerBrokerCleanup();
        return { kind: "started", runtime, diagnostics };
    } catch (error) {
        return { kind: "failed", runtime, detail: supervisionErrorDetail(error), diagnostics };
    } finally {
        if (descriptor !== null) {
            try { closeSync(descriptor); } catch { /* parent descriptor release is best effort */ }
        }
    }
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
    const endpoint = brokerEndpoints.getStore() || selectedBrokerEndpoint();
    const runtimeFile = brokerRuntimeFile();
    try {
        return readDeviceLabStateFile(runtimeFile, (parsed) => {
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid-broker-runtime");
            if (endpoint.configured && parsed.port !== endpoint.port) throw new Error("invalid-broker-runtime-port");
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
    const endpoint = brokerEndpoints.getStore() || selectedBrokerEndpoint(options);
    const allowDefault = behavior?.allowDefault !== false;
    // Public operation args are later merged with this route. Keep their deadline intact.
    const probeTimeout = Number.isFinite(options.brokerProbeTimeoutMs)
        ? { brokerProbeTimeoutMs: normalizeProbeOptions(options).timeoutMs }
        : { timeoutMs: Number.isFinite(options.timeoutMs) ? normalizeProbeOptions(options).timeoutMs : 1000 };
    const defaultProbe = (autolaunchDefault = true) => {
        const probe = normalizeProbeOptions({ ...options, probe: true });
        return {
            hostCandidates: probe.hostCandidates,
            port: probe.port,
            ...probeTimeout,
            autolaunch: options.autolaunch === true || (options.autolaunch !== false && autolaunchDefault),
        };
    };
    if (Array.isArray(options.hostCandidates) || Number.isInteger(options.port) || endpoint.configured) return defaultProbe(false);
    const runtime = readBrokerRuntime();
    if (!runtime) return allowDefault ? defaultProbe() : null;
    const hostCandidates = runtimeHostCandidates(runtime);
    if (!runtime.host || !Number.isInteger(runtime.port)) return allowDefault ? defaultProbe() : null;
    if (runtime.managedBy === "device-lab-mcp" && runtime.ownerId !== ownerId()) return null;
    if (runtime.managedBy !== "device-lab-mcp" && runtime.managedBy !== "ccc-host") return null;
    return {
        hostCandidates,
        port: runtime.port,
        ...probeTimeout,
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

function brokerRuntimeMatches(expected) {
    if (expected === null) {
        try { lstatSync(brokerRuntimeFile()); return false; }
        catch (error) { return error?.code === "ENOENT"; }
    }
    return Boolean(expected && isDeepStrictEqual(readBrokerRuntime(), expected));
}

function writeBrokerRuntime(runtime, expected) {
    const remaining = brokerOperations.getStore()?.macosCreateRemainingMs;
    return withSharedMutationLock(`${brokerRuntimeFile()}.lock`, () => {
        if (!brokerRuntimeMatches(expected)) return false;
        assertMacosCreateAllowance();
        writeJsonFileAtomically(brokerRuntimeFile(), runtime);
        return true;
    }, remaining ? {waitBudget: {remaining}} : {});
}

function removeBrokerRuntime(expected) {
    if (!expected) return false;
    const remaining = brokerOperations.getStore()?.macosCreateRemainingMs;
    try {
        return withSharedMutationLock(`${brokerRuntimeFile()}.lock`, () => {
            if (!brokerRuntimeMatches(expected)) return false;
            assertMacosCreateAllowance();
            unlinkSync(brokerRuntimeFile());
            return true;
        }, remaining ? {waitBudget: {remaining}} : {});
    } catch {
        // Unknown, changed or unreadable metadata is retained as evidence.
        return false;
    }
}

export const writeBrokerRuntimeForTest = writeBrokerRuntime;
export const removeBrokerRuntimeForTest = removeBrokerRuntime;

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

export function brokerLaunchInvocation(host, port, options = {}) {
    const brokerEntry = fileURLToPath(import.meta.resolve("@ccc/device-lab/broker-entry.js"));
    const brokerArgs = ["devices", "broker", "serve", "--host", host, "--port", String(port), "--runtime-managed-by-parent"];
    return { command: options.execPath || process.execPath, args: [brokerEntry, ...brokerArgs] };
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
    const endpoint = brokerEndpoints.getStore() || selectedBrokerEndpoint(options);
    const hostCandidates = Array.isArray(options.hostCandidates) && options.hostCandidates.length > 0
        ? options.hostCandidates.map(String).slice(0, MAX_PROBE_CANDIDATES)
        : endpoint.configured ? ["127.0.0.1"] : HOST_CANDIDATES;
    const port = Number.isInteger(options.port) ? Number(options.port) : endpoint.port;
    const probeTimeoutMs = Number.isFinite(options.brokerProbeTimeoutMs) ? options.brokerProbeTimeoutMs : options.timeoutMs;
    const timeoutMs = Number.isFinite(probeTimeoutMs)
        ? Math.min(MAX_PROBE_TIMEOUT_MS, Math.max(1, Number(probeTimeoutMs)))
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
    assertMacosCreateAllowance();
    timeoutMs = macosCreateTimeoutMs(timeoutMs);
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

async function probeBrokerHealth({ hostCandidates, port, timeoutMs: timeout }) {
    const attempts = [];
    for (const host of hostCandidates) {
        const timeoutMs = macosCreateTimeoutMs(timeout);
        if (timeoutMs < 1) break;
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

async function probeCccHostBrokerProtocol(host, port, timeoutMs) {
    assertMacosCreateAllowance();
    timeoutMs = macosCreateTimeoutMs(timeoutMs);
    const endpoint = `http://${host}:${port}/status`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    try {
        const response = await fetch(endpoint, { signal: controller.signal, redirect: "manual" });
        const parsed = await readBrokerHttpJson(response, BROKER_CONTROL_RESPONSE_LIMIT_BYTES);
        const body = parsed.body;
        const protocolVersion = body?.broker?.protocolVersion ?? null;
        return {
            ok: parsed.ok && response.ok && body?.ok === true && isCompatibleBrokerProtocol(protocolVersion),
            endpoint,
            status: response.status,
            body,
            protocolVersion,
            expectedProtocolVersion: DEVICE_BROKER_PROTOCOL_VERSION,
            durationMs: Date.now() - startedAt,
            ...(parsed.ok ? {} : { error: parsed.error, maxBytes: parsed.maxBytes }),
        };
    } catch (error) {
        return {
            ok: false,
            endpoint,
            status: null,
            body: null,
            protocolVersion: null,
            expectedProtocolVersion: DEVICE_BROKER_PROTOCOL_VERSION,
            durationMs: Date.now() - startedAt,
            error: error?.name === "AbortError" ? "timeout" : error?.message || String(error),
        };
    } finally {
        clearTimeout(timer);
    }
}

export const probeCccHostBrokerProtocolForTest = probeCccHostBrokerProtocol;

async function waitForBrokerHealth({ host, port, timeoutMs }) {
    const deadline = performance.now() + macosCreateTimeoutMs(timeoutMs);
    const attempts = [];
    for (;;) {
        const remainingMs = macosCreateTimeoutMs(deadline - performance.now());
        if (!(remainingMs > 0)) break;
        const probe = await probeBrokerHealth({ hostCandidates: [host], port, timeoutMs: Math.min(250, remainingMs) });
        attempts.push(...probe.attempts);
        const afterProbeMs = deadline - performance.now();
        if (probe.available && afterProbeMs > 0) return { ...probe, attempts };
        if (!(afterProbeMs > 0)) break;
        await new Promise((resolve) => setTimeout(resolve, Math.min(50, afterProbeMs)));
    }
    return { requested: true, available: false, selected: null, attempts };
}

function cleanupOwnedBrokerChildrenOnExit() { brokerEndpoints.run(null, () => brokerSupervision.cleanupOwnedOnExit()); }

async function cleanupOwnedBrokerChildren() {
    const endpoints = new Map([...ownedBrokerChildren.values()].map(owned => [`${owned.endpoint.runtimeFilename}:${owned.endpoint.port}`, owned.endpoint]));
    for (const endpoint of endpoints.values()) {
        await brokerEndpoints.run(endpoint, () => brokerSupervision.cleanupOwnedChildren());
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
    const deadline = performance.now() + macosCreateTimeoutMs(timeoutMs);
    for (;;) {
        const remainingMs = deadline - performance.now();
        if (!(remainingMs > 0)) break;
        const exited = !pidAlive(pid);
        const afterProbeMs = deadline - performance.now();
        if (exited && afterProbeMs > 0) return true;
        if (!(afterProbeMs > 0)) break;
        await new Promise((resolve) => setTimeout(resolve, Math.min(50, afterProbeMs)));
    }
    return false;
}

async function terminateBrokerProcess(pid, timeoutMs = 3000, expectedStartToken = null) {
    timeoutMs = macosCreateTimeoutMs(timeoutMs);
    if (timeoutMs < 1) return {ok: false, pid, reason: "macos-tart-create-budget-exhausted"};
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
    timeoutMs = macosCreateTimeoutMs(timeoutMs);
    if (timeoutMs < 1) return {ok: false, pid, reason: "macos-tart-create-budget-exhausted"};
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
        && (/\bccc(?:\.cmd|\.exe)?\b/i.test(normalized) || /\bnode(?:\.exe)?\b.*\bindex\.js\b/i.test(normalized)
            || Boolean(expectedCliPath && expectedPathVerified && /(?:^|\/)broker-entry\.js$/i.test(normalizedPath(commandTokens[1]))))
        && new RegExp(`(?:^|\\s)--port(?:=|\\s+)${port}(?:\\s|$)`).test(normalized)
        && expectedPathVerified;
}

function discoverLinuxBrokerPortProcess(port) {
    const portHex = Number(port).toString(16).toUpperCase().padStart(4, "0");
    const inodes = new Set();
    for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
        if (macosCreateTimeoutMs(Infinity) < 1) return null;
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
            if (macosCreateTimeoutMs(Infinity) < 1) return null;
            let fds = [];
            try { fds = readdirSync(`/proc/${pidText}/fd`); } catch { continue; }
            for (const fd of fds) {
                if (macosCreateTimeoutMs(Infinity) < 1) return null;
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

function completedBrokerNativeObservation(result, stage, onObservation) {
    if (result.status === 0 && !result.error && !result.signal) return true;
    onObservation?.({
        stage,
        reason: "native-command-failed",
        status: Number.isInteger(result.status) ? result.status : null,
        signal: ["SIGHUP", "SIGINT", "SIGQUIT", "SIGILL", "SIGTRAP", "SIGABRT", "SIGBUS", "SIGFPE", "SIGKILL", "SIGUSR1", "SIGSEGV", "SIGUSR2", "SIGPIPE", "SIGALRM", "SIGTERM", "SIGCHLD", "SIGCONT", "SIGSTOP", "SIGTSTP", "SIGTTIN", "SIGTTOU", "SIGWINCH", "SIGBREAK"].includes(result.signal) ? result.signal : null,
        code: ["ENOENT", "EACCES", "EPERM", "ESRCH", "ETIMEDOUT", "ENOBUFS", "EINVAL", "EIO", "ENOMEM", "E2BIG", "EBADF", "EAGAIN"].includes(result.error?.code) ? result.error.code : null,
    });
    return false;
}

function discoverCommandBrokerPortProcess(command, args, onObservation) {
    let deadline = performance.now() + macosCreateTimeoutMs(5000);
    const observationTimeoutMs = maximum => {
        deadline = Math.min(deadline, performance.now() + macosCreateTimeoutMs(5000));
        return Math.max(0, Math.floor(Math.min(maximum, deadline - performance.now())));
    };
    let timeout = observationTimeoutMs(5000);
    if (timeout < 1) {
        onObservation?.({ stage: "listener", reason: "budget-exhausted" });
        return null;
    }
    const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, timeout });
    if (!completedBrokerNativeObservation(result, "listener", onObservation)) return null;
    const pid = Number((result.stdout?.match(/^p(\d+)$/m) || [])[1]);
    if (!Number.isInteger(pid) || pid <= 0) {
        onObservation?.({ stage: "listener", reason: "native-output-unavailable" });
        return null;
    }
    timeout = observationTimeoutMs(1000);
    if (timeout < 1) {
        onObservation?.({ stage: "command", reason: "budget-exhausted" });
        return null;
    }
    const psExecutable = process.platform === "darwin" ? "/bin/ps" : "ps";
    const psArgs = process.platform === "darwin" ? ["-ww", "-p", String(pid), "-o", "command="] : ["-p", String(pid), "-o", "command="];
    const ps = spawnSync(psExecutable, psArgs, { encoding: "utf8", windowsHide: true, timeout });
    if (!completedBrokerNativeObservation(ps, "command", onObservation)) return null;
    timeout = observationTimeoutMs(1000);
    if (timeout < 1) {
        onObservation?.({ stage: "start-token", reason: "budget-exhausted" });
        return null;
    }
    const started = spawnSync(psExecutable, ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", windowsHide: true, timeout });
    if (!completedBrokerNativeObservation(started, "start-token", onObservation)) return null;
    const commandLine = String(ps.stdout || "").trim();
    const startedAt = String(started.stdout || "").trim();
    if (!startedAt) {
        onObservation?.({ stage: "start-token", reason: "native-output-unavailable" });
        return null;
    }
    if (observationTimeoutMs(1000) < 1) {
        onObservation?.({ stage: "start-token", reason: "budget-exhausted" });
        return null;
    }
    return { pid, commandLine, processStartToken: `ps:${startedAt}` };
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
    const netstatTimeout = macosCreateTimeoutMs(1500);
    if (netstatTimeout < 1) return null;
    const netstatPath = canonicalWindowsSystemExecutablePath("netstat.exe");
    const netstat = netstatPath ? spawnSync(netstatPath, ["-ano", "-p", "tcp"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: netstatTimeout,
    }) : { status: null, stdout: "" };
    const listener = netstat.status === 0 ? parseWindowsNetstatListenerForTest(netstat.stdout, port) : null;
    if (!listener) return null;
    const powershell = canonicalWindowsPowerShellPath();
    const identityTimeout = macosCreateTimeoutMs(1500);
    if (identityTimeout < 1) return null;
    const script = [
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${listener.pid}"`,
        `$h = Get-Process -Id ${listener.pid} -ErrorAction SilentlyContinue`,
        "if (-not $p -or -not $h) { exit 1 }",
        "[pscustomobject]@{ pid = [int]$p.ProcessId; commandLine = [string]$p.CommandLine; startToken = $h.StartTime.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress",
    ].join("; ");
    const result = powershell ? spawnSync(powershell, hiddenWindowsPowerShellArgs(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script]), {
        encoding: "utf8",
        windowsHide: true,
        timeout: identityTimeout,
    }) : { status: null, stdout: "" };
    if (result.status === 0 && result.stdout) {
        try {
            const parsed = JSON.parse(result.stdout);
            const pid = Number(parsed?.pid);
            if (pid === listener.pid) {
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
    return { ...listener, processStartToken: readBrokerProcessStartToken(listener.pid, "win32") };
}

function discoverBrokerPortProcess(port, onObservation) {
    if (process.platform === "linux") return discoverLinuxBrokerPortProcess(port);
    if (process.platform === "darwin") return discoverCommandBrokerPortProcess("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"], onObservation);
    if (process.platform === "win32") return discoverWindowsBrokerPortProcess(port);
    return null;
}

function readBrokerProcessStartToken(pid, platform = process.platform) {
    if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return null;
    if (macosCreateTimeoutMs(Infinity) < 1) return null;
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
        const timeout = macosCreateTimeoutMs(1500);
        if (timeout < 1) return null;
        const result = spawnSync(powershell, hiddenWindowsPowerShellArgs(["-NoProfile", "-NonInteractive", "-Command", script]), {
            encoding: "utf8",
            windowsHide: true,
            timeout,
        });
        const value = result.status === 0 ? String(result.stdout || "").trim() : "";
        return value ? `windows:${value}` : null;
    }
    const timeout = macosCreateTimeoutMs(1000);
    if (timeout < 1) return null;
    const result = spawnSync(platform === "darwin" ? "/bin/ps" : "ps", ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf8",
        windowsHide: true,
        timeout,
    });
    const value = completedBrokerNativeObservation(result, "start-token") ? String(result.stdout || "").trim() : "";
    return value ? `ps:${value}` : null;
}

/** @param {import('./domain/broker-supervision.mjs').BrokerStatus|null} [statusBroker] */
function verifiedBrokerProcess(
    runtime,
    port = Number(runtime?.port),
    statusBroker = null,
    portProcessResolver = discoverBrokerPortProcess,
    onObservation,
) {
    const pid = Number(runtime?.pid);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port)) return null;
    const observed = portProcessResolver(port, onObservation);
    if (macosCreateTimeoutMs(Infinity) < 1) {
        onObservation?.({ stage: "identity", reason: "budget-exhausted" });
        return null;
    }
    const command = String(runtime?.command || "").replace(/\\/g, "/");
    const nodeLaunch = /(?:^|\/)node(?:\.exe)?$/i.test(command);
    const expectedCliPath = nodeLaunch && Array.isArray(runtime?.args) && typeof runtime.args[0] === "string"
        ? runtime.args[0]
        : null;
    if (!observed) return null;
    if (observed.pid !== pid) {
        onObservation?.({ stage: "identity", reason: "listener-pid-mismatch" });
        return null;
    }
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
    if (!statusProcessVerified) {
        onObservation?.({ stage: "identity", reason: "status-identity-unverified" });
        return null;
    }
    if (isBrokerServeCommandLine(observed.commandLine, port, expectedCliPath)) {
        if (runtimeContinuity) return { ...observed, source: "port-process-plus-runtime-and-status" };
        onObservation?.({ stage: "identity", reason: "runtime-continuity-unverified" });
        return null;
    }
    if (!String(observed.commandLine || "").trim()
        && runtimeContinuity
        && statusStartedAt === runtimeStartedAt) {
        return { ...observed, source: "port-pid-plus-runtime-and-status" };
    }
    onObservation?.({ stage: "identity", reason: !String(observed.commandLine || "").trim() ? "runtime-continuity-unverified" : "command-line-unverified" });
    return null;
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

function isLoopbackBrokerHost(host) {
    const normalizedHost = String(host || "").trim().toLowerCase();
    return normalizedHost === "127.0.0.1" || normalizedHost === "localhost" || normalizedHost === "::1";
}

function linuxProcessIsDefunct(procRoot, pid) {
    let state;
    try {
        const stat = readFileSync(`${procRoot}/${pid}/stat`, "utf8");
        state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
    } catch (error) {
        // A process that vanished between the directory listing and this read holds nothing.
        return error?.code === "ENOENT" || error?.code === "ESRCH";
    }
    if (state !== "Z" && state !== "X") return false;
    // A leader thread that exited reports Z while its other threads keep running and keep every
    // descriptor open, so Z alone proves nothing. Only a process whose task list holds no thread but
    // the leader has released its descriptors; anything else, or an unreadable list, is not defunct.
    try {
        return readdirSync(`${procRoot}/${pid}/task`).every((task) => task === String(pid));
    } catch (error) {
        return error?.code === "ENOENT" || error?.code === "ESRCH";
    }
}

// Who, if anyone in this container, answers a TCP connection to 127.0.0.1:<port>? The answer is one
// of five states. "outside-pid-namespace" is best-effort evidence against a local listener that is
// not trying to hide; a process in the container that deliberately shuffles its socket between
// descriptors or processes can evade it. That is acceptable only because such a process already
// holds the owner secret and passwordless sudo. Only two states widen trust:
//   absent                 no LISTEN socket on the port in this network namespace, so a loopback
//                          connection that succeeded was carried out of it (Docker Desktop's
//                          iptables REDIRECT to ccc-proxy, WSL2 mirrored loopback, ...).
//   outside-pid-namespace  a LISTEN socket exists, but no process in this PID namespace holds it
//                          and every live process here was inspected (native-Linux --network host:
//                          the host broker's socket is in the shared netns, its PID is not).
//   visible-owner          a process in this PID namespace holds the socket: a local listener.
//   indeterminate          a LISTEN socket exists, no inspected process holds it, but some live
//                          process's fd table was unreadable, so it may be the owner.
//   unavailable            procfs could not answer (non-Linux client, hidden /proc/net).
// The last three never widen trust; callers fall back to strict local process verification.
function inspectLocalLoopbackListener(port, options = {}) {
    const platform = options.platform ?? process.platform;
    const procRoot = options.procRoot ?? "/proc";
    const expectedPort = Number(port);
    if (platform !== "linux") return { state: "unavailable", port: expectedPort, reason: "unsupported-platform" };
    if (!Number.isInteger(expectedPort) || expectedPort < 1 || expectedPort > 65535) {
        return { state: "unavailable", port: expectedPort, reason: "invalid-port" };
    }
    const portHex = expectedPort.toString(16).toUpperCase().padStart(4, "0");
    const inodes = new Set();
    let tablesRead = 0;
    for (const table of ["tcp", "tcp6"]) {
        let text;
        try {
            text = readFileSync(`${procRoot}/net/${table}`, "utf8");
        } catch (error) {
            // tcp6 is legitimately missing when IPv6 is disabled; anything else is not an answer.
            if (error?.code === "ENOENT") continue;
            return { state: "unavailable", port: expectedPort, reason: `proc-net-${table}-unreadable` };
        }
        tablesRead += 1;
        for (const line of text.trim().split(/\n/).slice(1)) {
            const fields = line.trim().split(/\s+/);
            if (fields[3] === "0A" && (fields[1] || "").split(":").pop() === portHex && fields[9]) inodes.add(fields[9]);
        }
    }
    if (tablesRead === 0) return { state: "unavailable", port: expectedPort, reason: "proc-net-tcp-missing" };
    if (inodes.size === 0) return { state: "absent", port: expectedPort };
    const listenerInodes = [...inodes];
    const listPids = options.listPids || (() => readdirSync(procRoot).filter((entry) => /^\d+$/.test(entry)));
    // Re-list /proc until a round turns up no pid that was not already scanned, so a holder that
    // keeps handing the socket to freshly forked children cannot live only in the gap between the
    // listing and the scan. A list that never settles proves nothing.
    const scanned = new Set();
    const uninspectablePids = [];
    for (let round = 0; round < LOCAL_LISTENER_SCAN_ROUNDS; round += 1) {
        let pids;
        try {
            pids = listPids();
        } catch {
            return { state: "unavailable", port: expectedPort, reason: "proc-unreadable", inodes: listenerInodes };
        }
        const fresh = pids.filter((pid) => !scanned.has(pid));
        if (fresh.length === 0) {
            return uninspectablePids.length > 0
                ? { state: "indeterminate", port: expectedPort, inodes: listenerInodes, uninspectablePids: uninspectablePids.slice(0, 8) }
                : { state: "outside-pid-namespace", port: expectedPort, inodes: listenerInodes };
        }
        for (const pidText of fresh) {
            scanned.add(pidText);
            const scan = scanLinuxProcessForSockets(procRoot, pidText, inodes);
            if (scan.owner) return { state: "visible-owner", port: expectedPort, pid: Number(pidText), inodes: listenerInodes };
            if (scan.uninspectable) uninspectablePids.push(Number(pidText));
        }
    }
    return {
        state: "indeterminate",
        port: expectedPort,
        inodes: listenerInodes,
        reason: "pid-list-unsettled",
        uninspectablePids: uninspectablePids.slice(0, 8),
    };
}

const LOCAL_LISTENER_SCAN_ROUNDS = 8;

// Does this process hold one of the listening socket inodes? Every thread's fd table is read, not
// just the leader's: a thread that unshared CLONE_FILES keeps its descriptors only under
// /proc/<pid>/task/<tid>/fd. A table or link that cannot be read (other than a race with exit)
// leaves the process uninspected, unless it is a zombie that has released everything.
function scanLinuxProcessForSockets(procRoot, pidText, inodes) {
    const fdDirs = [`${procRoot}/${pidText}/fd`];
    try {
        for (const task of readdirSync(`${procRoot}/${pidText}/task`)) {
            if (/^\d+$/.test(task) && task !== pidText) fdDirs.push(`${procRoot}/${pidText}/task/${task}/fd`);
        }
    } catch (error) {
        if (error?.code === "ENOENT" || error?.code === "ESRCH") {
            // The process exited after the listing, or (fake procfs) has no task list: the leader's
            // table below is still read, and an exited process simply yields nothing.
        } else {
            return { owner: false, uninspectable: !linuxProcessIsDefunct(procRoot, pidText) };
        }
    }
    let uninspectable = false;
    for (const dir of fdDirs) {
        let fds;
        try {
            fds = readdirSync(dir);
        } catch (error) {
            if (error?.code !== "ENOENT" && error?.code !== "ESRCH") uninspectable = true;
            continue;
        }
        for (const fd of fds) {
            let target = "";
            try {
                target = readlinkSync(`${dir}/${fd}`);
            } catch (error) {
                // A descriptor closed after the listing holds nothing; any other failure (a denied
                // ptrace read, an LSM refusal) means this table was not inspected.
                if (error?.code === "ENOENT" || error?.code === "ESRCH") continue;
                uninspectable = true;
                break;
            }
            const match = /^socket:\[(\d+)\]$/.exec(target);
            if (match && inodes.has(match[1])) return { owner: true, uninspectable: false };
        }
    }
    // Zombies keep their /proc entry but have already released every descriptor.
    return { owner: false, uninspectable: uninspectable && !linuxProcessIsDefunct(procRoot, pidText) };
}

export const inspectLocalLoopbackListenerForTest = inspectLocalLoopbackListener;

// A loopback broker endpoint seen from inside a ccc container is not necessarily a local process.
// On Docker Desktop (Windows/macOS) the container's 127.0.0.1 traffic is REDIRECTed to ccc-proxy,
// which connects to 127.0.0.1:<port> in this netns first and otherwise to host.docker.internal, so
// http://127.0.0.1:17373 reaches the Windows host broker. Its PID lives on another OS, and strict
// local port-process verification (keyed on THIS process's platform) can never succeed for it.
//
// The decision is driven by the listener table, not by platform strings. Platform is neither
// necessary nor sufficient: native-Linux --network host puts a linux host broker behind the same
// loopback (same platform, still outside our PID namespace), and a win32 claim in the host-written
// runtime file says nothing about who answers 127.0.0.1 here. If a process in this container holds
// the port, ccc-proxy routes to it before the host, so a visible local listener always falls back
// to strict verification regardless of what platform the runtime or /status reports.
//
// Accepted endpoints get exactly the cross-host-container-boundary trust: the runtime must be the
// host CLI's (managedBy "ccc-host"), and authenticated RPCs are still bound to that runtime's
// pid/start token/startedAt by verifyAuthenticatedBrokerGeneration.
//
// When ccc-proxy carries this container's loopback (CCC_PROXY_ENABLED=1, Docker Desktop), the host
// broker lives on another OS and never appears in this netns. A listener that is here but outside
// our PID namespace belongs to another container on the same VM, and ccc-proxy would route to it
// before the host, so only "absent" proves the endpoint is the host.
function loopbackForwardedContainerBoundary(runtime, port, options = {}) {
    const containerBoundary = options.containerBoundary ?? existsSync("/.dockerenv");
    if (runtime?.managedBy !== "ccc-host" || !containerBoundary) return { ok: false, applicable: false };
    const inspector = options.localListenerInspector || inspectLocalLoopbackListener;
    const listener = inspector(Number(port)) || { state: "unavailable", port: Number(port), reason: "no-inspection" };
    // CCC_CONTAINER_HOST_REMOTE is fixed at container creation on VM-backed runtimes, whatever the
    // proxy opt-out; CCC_PROXY_ENABLED covers containers created before it existed, and
    // CCC_DISABLE_PROXY (forwarded per session) the opt-out on those older containers. Any of them
    // means this netns is a VM's, shared with other containers, so only "absent" proves the host.
    const proxied = (options.loopbackProxyEnabled
        ?? (process.env.CCC_CONTAINER_HOST_REMOTE === "1"
            || process.env.CCC_PROXY_ENABLED === "1"
            || process.env.CCC_DISABLE_PROXY === "1")) === true;
    return {
        ok: listener.state === "absent" || (!proxied && listener.state === "outside-pid-namespace"),
        applicable: true,
        listener,
    };
}

function reusableBrokerProcessVerification(runtime, port, host, options = {}) {
    const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV;
    const testEscape = options.testEscape ?? process.env.CCC_DEVICE_LAB_TEST_ALLOW_UNVERIFIED_BROKER;
    if (nodeEnv === "test" && testEscape === "1") {
        return { ok: true, source: "explicit-test-fixture" };
    }
    const normalizedHost = String(host || "").trim().toLowerCase();
    const loopback = isLoopbackBrokerHost(normalizedHost);
    const containerBoundary = options.containerBoundary ?? existsSync("/.dockerenv");
    if (runtime?.managedBy === "ccc-host"
        && containerBoundary
        && !loopback
        && TRUSTED_BROKER_HOSTS.has(normalizedHost)) {
        return { ok: true, source: "cross-host-container-boundary" };
    }
    let localListener = null;
    if (loopback) {
        const forwarded = loopbackForwardedContainerBoundary(runtime, port, { ...options, containerBoundary });
        if (forwarded.ok) {
            return { ok: true, source: "loopback-forwarded-container-boundary", localListener: forwarded.listener };
        }
        if (forwarded.applicable) localListener = forwarded.listener;
    }
    let observation = null;
    const verified = options.processVerifier
        ? options.processVerifier(runtime, port, options.statusBroker || null)
        : verifiedBrokerProcess(runtime, port, options.statusBroker || null, discoverBrokerPortProcess, detail => { observation ||= detail; });
    return verified
        ? { ok: true, source: verified.source, verified }
        : { ok: false, source: "unverified-broker-port-process", ...(localListener ? { localListener } : {}), ...(observation ? { observation } : {}) };
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
    if (!writeBrokerRuntime(verifiedRuntime, runtime)) return runtime;
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

async function cleanupLaunchedBrokerRuntime(runtime, timeoutMs) {
    if (!runtime.pid) {
        removeBrokerRuntime(runtime);
        return { ok: true, stale: true, pid: null };
    }
    let termination;
    try {
        termination = await terminateBrokerProcess(
            runtime.pid,
            timeoutMs,
            runtime?.processStartToken || null,
        );
    } catch (error) {
        termination = {
            ok: false,
            pid: runtime.pid,
            reason: "broker-launch-cleanup-failed",
            detail: error?.message || String(error),
        };
    }
    if (termination.ok) {
        const owned = ownedBrokerChildren.get(runtime.pid);
        if (runtime.processStartToken && owned?.processStartToken === runtime.processStartToken) ownedBrokerChildren.delete(runtime.pid);
        removeBrokerRuntime(runtime);
    }
    return termination;
}

export async function waitForBrokerOwnerResolve(host, port, timeoutMs) {
    const deadline = performance.now() + macosCreateTimeoutMs(Math.max(1, timeoutMs));
    const attempts = [];
    let lastResult = null;
    let lastHttpFailure = null;
    for (;;) {
        const remainingMs = macosCreateTimeoutMs(deadline - performance.now());
        if (!(remainingMs > 0)) break;
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
        const afterProbeMs = deadline - performance.now();
        if (resolved.ok && afterProbeMs > 0) return { ...resolved, attempts };
        if (!(afterProbeMs > 0)) break;
        await new Promise((resolve) => setTimeout(resolve, Math.min(100, afterProbeMs)));
    }
    return {
        ok: false,
        error: lastHttpFailure?.body?.error || lastResult?.error || "broker-owner-resolve-readiness-timeout",
        selected: lastResult?.selected || lastHttpFailure || null,
        attempts,
    };
}



function ensureBroker(options = {}) { return withBrokerEndpoint(options, () => brokerSupervision.ensure(options)); }



export async function brokerShutdown(options = {}) { return withBrokerEndpoint(options, () => brokerSupervision.shutdown(options)); }

function isolatedBrokerAuthFile() {
    const configured = String(process.env.CCC_DEVICE_BROKER_AUTH_FILE || "").trim();
    if (configured) return resolve(configured);
    const conventional = "/run/ccc-device-broker-auth/owner.json";
    try {
        lstatSync(conventional);
        return conventional;
    } catch (error) {
        // An inaccessible or invalid isolated mount must never expose a legacy
        // credential. Only an absent mount allows the normal host-side layout.
        return error?.code === "ENOENT" ? null : conventional;
    }
}

function brokerAuthSecretFile(owner, isolatedFile) {
    if (!/^[a-f0-9]{16}$/.test(owner)) throw new Error("invalid-owner-id");
    if (isolatedFile) return isolatedFile;
    return join(brokerStateRoot(), "broker", "auth", `${owner}.json`);
}

function brokerAuthDirectoryValid(isolatedFile) {
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

function existingOwnerSecret(owner) {
    const isolatedFile = isolatedBrokerAuthFile();
    if (!brokerAuthDirectoryValid(isolatedFile)) return null;
    return readBrokerOwnerSecret(brokerAuthSecretFile(owner, isolatedFile), owner);
}

function ownerToken(owner) {
    const secret = existingOwnerSecret(owner);
    return secret
        ? createHash("sha256").update(`${BROKER_NAME}:owner:${owner}:secret:${secret}`).digest("hex")
        : null;
}

async function resolveBrokerOwner(probeOptions, waitBudget) {
    const attempts = [];
    const requestBody = JSON.stringify({
        projectMountPath: projectMountPath(),
        profile: process.env.CCC_PROFILE || null,
    });
    for (const host of probeOptions.hostCandidates) {
        const timeoutMs = macosCreateTimeoutMs(waitBudget ? waitBudget.requestTimeout(probeOptions.timeoutMs) : probeOptions.timeoutMs);
        if (timeoutMs <= 0) break;
        const endpoint = `http://${host}:${probeOptions.port}/v1/owner/resolve`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
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

// `boundaryOptions` is deliberately separate from `options`: the latter carries caller-supplied RPC
// options, which must never be able to assert a container boundary or inject a listener inspector.
async function verifyAuthenticatedBrokerGeneration(host, port, launch, options, boundaryOptions = {}, onObservation) {
    if (typeof options.verifyBeforeAuthenticatedRequest === "function"
        && options.verifyBeforeAuthenticatedRequest() !== true) {
        return null;
    }
    if (process.env.NODE_ENV === "test"
        && process.env.CCC_DEVICE_LAB_TEST_ALLOW_UNVERIFIED_BROKER === "1") {
        return { ...(launch?.runtime || readBrokerRuntime() || {}), testOnly: true };
    }
    const probeTimeoutMs = options.brokerProbeTimeoutMs ?? options.timeoutMs;
    const attestationTimeoutMs = Number.isFinite(Number(probeTimeoutMs))
        ? Math.min(5000, Math.max(1, Number(probeTimeoutMs)))
        : 5000;
    const attestation = await probeCccHostBrokerProtocol(host, port, attestationTimeoutMs);
    const broker = attestation?.body?.broker;
    const brokerPid = Number(broker?.process?.pid);
    const brokerStartToken = typeof broker?.process?.startToken === "string" ? broker.process.startToken : "";
    const brokerStartedAt = typeof broker?.startedAt === "string" ? broker.startedAt : "";
    if (!attestation.ok || !Number.isInteger(brokerPid) || brokerPid <= 0 || !brokerStartToken || !brokerStartedAt) {
        onObservation?.({ stage: "identity", reason: "status-identity-unverified" });
        return null;
    }
    const runtime = launch?.runtime || readBrokerRuntime();
    if (!runtime) {
        onObservation?.({ stage: "identity", reason: "invalid-runtime" });
        return null;
    }
    if (
        Number(runtime.port) !== Number(port)
        || Number(runtime.pid) !== brokerPid
        || runtime.processStartToken !== brokerStartToken
        || runtime.startedAt !== brokerStartedAt
    ) {
        onObservation?.({ stage: "identity", reason: "runtime-continuity-unverified" });
        return null;
    }
    if (!isLoopbackBrokerHost(host)) return runtime;
    // The generation match above already bound this runtime to the answering broker's identity; a
    // loopback endpoint forwarded out of the container cannot additionally be port-verified here.
    if (loopbackForwardedContainerBoundary(runtime, port, boundaryOptions).ok) return runtime;
    const processVerifier = boundaryOptions.processVerifier;
    const verified = processVerifier
        ? processVerifier(runtime, Number(port), broker)
        : verifiedBrokerProcess(runtime, Number(port), broker, discoverBrokerPortProcess, onObservation);
    return verified ? runtime : null;
}

export const verifyAuthenticatedBrokerGenerationForTest = verifyAuthenticatedBrokerGeneration;

function authenticatedBrokerHeaders(token, owner, runtime, body) {
    if (runtime.testOnly === true && process.env.NODE_ENV === "test"
        && process.env.CCC_DEVICE_LAB_TEST_ALLOW_UNVERIFIED_BROKER === "1") {
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
    return withBrokerEndpoint(options, () => brokerRpcRequestScoped(options));
}

async function brokerRpcRequestScoped(options) {
    const macosCreate = options.method === "broker.command.invoke" && isBrokerMacosTartImageCreate(options.params || {});
    const deadline = macosCreate ? performance.now() + brokerMacosTartCreateRpcTimeoutMs(options) : 0;
    try {
        const result = macosCreate
            ? await brokerOperations.run({...brokerOperations.getStore(), macosCreateRemainingMs: () => Math.max(0, deadline - performance.now())}, () => brokerRpcRequestUncached(options))
            : await brokerRpcRequestUncached(options);
        if (!result.ok) invalidateBrokerSetup();
        return result;
    } catch (error) {
        invalidateBrokerSetup();
        if (macosCreate && error?.code === "macos-tart-create-budget-exhausted") {
            return {ok: false, ownerId: ownerId(), error: error.code, attempts: []};
        }
        throw error;
    }
}

async function brokerRpcRequestUncached(options = {}) {
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
    const explicitRequestBudget = method === "broker.appium.request" && options.params?.requestTimeoutMs !== undefined;
    if (explicitRequestBudget && (typeof options.params.requestTimeoutMs !== "number"
        || !Number.isFinite(options.params.requestTimeoutMs) || options.params.requestTimeoutMs <= 0
        || options.params.requestTimeoutMs > 600000)) {
        return { ok: false, ownerId: owner, method, error: "invalid-appium-request-timeout", attempts: [] };
    }
    const macosCreateRemainingMs = method === "broker.command.invoke" && isBrokerMacosTartImageCreate(options.params || {})
        ? brokerOperations.getStore()?.macosCreateRemainingMs : undefined;
    let waitBudget = macosCreateRemainingMs ? {
        remaining: macosCreateRemainingMs,
        requestTimeout: (maximum = BROKER_MACOS_TART_CREATE_TIMEOUT_MS) => Math.max(0, Math.floor(Math.min(maximum, macosCreateRemainingMs()))),
    } : null;
    let launch = null;
    if (options.autolaunch === true) {
        launch = await ensureBroker(options);
        const processObservation = launch.attempts?.at(-1)?.processVerification?.observation;
        if (macosCreateRemainingMs && processObservation?.reason !== "native-command-failed") assertMacosCreateAllowance();
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
    if (!waitBudget && explicitRequestBudget) waitBudget = createWaitBudget(options.params.requestTimeoutMs);
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
    const resolvedOwner = brokerSetupEvidence.get(launch)?.ownerResolve || await resolveBrokerOwner(probeOptions, waitBudget);
    if (macosCreateRemainingMs) assertMacosCreateAllowance();
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
    const managedVmCreate = method === "broker.command.invoke" && options.params?.command === "device_create"
        && ["windows-vm", "linux-vm", "macos-vm"].includes(options.params?.backend)
        && options.params?.dryRun !== true;
    let observationRpcStarted = false;
    let candidateAttemptFailed = false;
    let observationBudgetExhausted = false;
    for (const host of probeOptions.hostCandidates) {
        if (waitBudget && waitBudget.remaining() <= 0) {
            // Owner/body/token admission already succeeded; no attestation or RPC is started here.
            observationBudgetExhausted = !observationRpcStarted && !candidateAttemptFailed;
            break;
        }
        let attemptTimeoutMs = rpcTimeoutMs;
        let rpcAttemptStarted = false;
        const rpcPath = `/v1/owners/${encodeURIComponent(owner)}/rpc`;
        const endpoint = `http://${host}:${probeOptions.port}${rpcPath}`;
        const startedAt = Date.now();
        try {
            let processObservation = null;
            const verifiedRuntime = await verifyAuthenticatedBrokerGeneration(host, probeOptions.port, launch, waitBudget ? { ...options, brokerProbeTimeoutMs: waitBudget.requestTimeout(5000), timeoutMs: waitBudget.requestTimeout(5000) } : options, undefined, detail => { processObservation ||= detail; });
            if (macosCreateRemainingMs && processObservation?.reason !== "native-command-failed") assertMacosCreateAllowance();
            if (!verifiedRuntime) {
                attempts.push({ reason: "broker-runtime-process-unverified", processVerification: {
                    ok: false, source: "unverified-broker-port-process",
                    ...(processObservation ? { observation: processObservation } : {}),
                } });
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
            if (waitBudget) {
                attemptTimeoutMs = waitBudget.requestTimeout(rpcTimeoutMs);
                if (attemptTimeoutMs <= 0) {
                    // This generation was genuinely attested, but its observation never started.
                    observationBudgetExhausted = !observationRpcStarted && !candidateAttemptFailed;
                    break;
                }
                requestBody = JSON.stringify({ ownerId: owner, method, params: {
                    ...options.params, requestTimeoutMs: attemptTimeoutMs,
                } });
            }
            observationRpcStarted = true;
            rpcAttemptStarted = true;
            const response = await brokerRpcHttpJsonRequest({
                host,
                port: probeOptions.port,
                path: rpcPath,
                timeoutMs: attemptTimeoutMs,
                // Only Hyper-V console frames are bounded this tightly; other desktop providers keep
                // the general RPC limit their larger native screenshots already fit under.
                maxBytes: method === "broker.device.tool.invoke" && options.params?.tool === "device_screenshot"
                    && (options.params?.backend === "windows-vm" || options.params?.backend === "linux-vm")
                    ? BROKER_RPC_SCREENSHOT_RESPONSE_LIMIT_BYTES
                    : BROKER_RPC_RESPONSE_LIMIT_BYTES,
                headers: {
                    "content-type": "application/json",
                    ...authenticatedBrokerHeaders(token, owner, verifiedRuntime, requestBody),
                },
                body: requestBody,
            });
            const macosCreateExpired = macosCreateRemainingMs && waitBudget && waitBudget.remaining() <= 0;
            if (!macosCreateRemainingMs && waitBudget && waitBudget.remaining() <= 0) {
                const error = new Error("broker RPC timed out");
                error.name = "AbortError";
                throw error;
            }
            const responseBody = response.responseBody;
            const body = responseBody.body;
            const attempt = {
                host,
                port: probeOptions.port,
                endpoint,
                ok: responseBody.ok && response.ok,
                status: response.status,
                durationMs: Date.now() - startedAt,
                timeoutMs: attemptTimeoutMs,
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
            if (macosCreateExpired && response.ok) {
                return {ok: false, ownerId: owner, method, selected: attempt, error: "macos-tart-create-budget-exhausted",
                    status: response.status, result: body?.result ?? body, body: summarizeBody(body), launch, attempts};
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
            candidateAttemptFailed = true; // Preserve prior failures across every host candidate.
            invalidateBrokerSetup();
            const failure = brokerTransportFailure(error);
            attempts.push({
                host,
                port: probeOptions.port,
                endpoint,
                ok: false,
                status: null,
                durationMs: Date.now() - startedAt,
                timeoutMs: attemptTimeoutMs,
                error: failure.error,
                transportCode: failure.transportCode,
                transportRetryable: failure.retryable,
            });
            // A VM birth may have completed when its POST response is lost.
            // Connection refusal confirms no submission; attestation failures occur before RPC.
            if (managedVmCreate && rpcAttemptStarted && failure.transportCode !== "connection-refused") break;
        }
    }
    const result = {
        ok: false,
        ownerId: owner,
        method,
        selected: null,
        error: observationBudgetExhausted ? "broker-observation-budget-exhausted-before-rpc" : "broker-rpc-unavailable",
        launch,
        attempts,
    };
    if (observationBudgetExhausted) localObservationBudgetExhaustions.add(result);
    return result;
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
    const macosCreate = action === "invoke" && isBrokerMacosTartImageCreate(options);
    const lifecycleTimeoutMs = action === "invoke" && options.dryRun !== true && !macosCreate && !Number.isFinite(options.timeoutMs)
        ? DEFAULT_LIFECYCLE_RPC_TIMEOUT_MS
        : options.timeoutMs;
    return brokerRpcRequest({
        ...options,
        ...(Number.isFinite(lifecycleTimeoutMs) ? { timeoutMs: lifecycleTimeoutMs } : {}),
        ...(macosCreate ? {rpcTimeoutMs: brokerMacosTartCreateRpcTimeoutMs(options)} : {}),
        method,
        params: {
            ...Object.fromEntries(Object.entries(plainObject(options.options)).filter(([key]) => key !== "incarnationId")),
            backend: options.backend,
            command: options.command,
            deviceId: options.deviceId,
            ...(options.detail === true ? { detail: true } : {}),
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
            nestedVirtualization: options.nestedVirtualization,
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
            preserveNetwork: options.preserveNetwork,
            deleteAvd: options.deleteAvd,
            deleteSimulator: options.deleteSimulator,
            dryRun: options.dryRun,
        },
    });
}

export const BROKER_DEVICE_TOOL_PARAM_KEYS = [
    "handle",
    "backend",
    "action",
    "serial",
    "host",
    "port",
    "pairHost",
    "udid",
    "pairPort",
    "pairingCode",
    "connect",
    "deviceId",
    "detail",
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
    "limit",
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
    "airplaneMode",
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

/** Observe the active app through the selected broker; transport facts stay outward.
 * @param {import('./ports/device-request.mjs').ActiveAppObservationInput} options
 * @returns {Promise<import('./ports/device-request.mjs').ActiveAppObservation>} */
export async function observeActiveApp(options) {
    const ios = options.backend.startsWith('ios');
    const broker = await brokerAppium({
        ...options,
        action: 'request',
        method: 'POST',
        path: ios ? '/execute/sync' : '/appium/device/app_state',
        body: ios ? {script:'mobile: activeAppInfo',args:[]} : {appId:String(options.expectedAppId)},
    });
    if (!broker.ok) return {kind:'failed',localBudgetExhausted:isLocalObservationBudgetExhaustion(broker),receipt:broker};
    const body = broker.result?.response?.body;
    const appState = body?.value ?? body ?? null;
    const activeAppId = ios && appState !== null && typeof appState === 'object'
        ? Reflect.get(appState, 'bundleId') ?? Reflect.get(appState, 'bundleID') ?? null : null;
    return {kind:'observed',activeAppId,foreground:ios ? false : Number(appState) >= 3,receipt:{broker,appState}};
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
            ...(action === "request" && options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
        },
    });
}

export async function brokerStatus(options = {}) {
    return withBrokerEndpoint(options, () => brokerStatusScoped(options));
}

async function brokerStatusScoped(options) {
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
    const setupEvidence = brokerSetupEvidence.get(launch);
    const probe = effectiveProbeOptions.probe
        ? setupEvidence?.health || await probeBrokerHealth(effectiveProbeOptions)
        : { requested: false, available: false, selected: null, attempts: [] };
    const ownerResolve = probe.available
        ? setupEvidence?.ownerResolve || await resolveBrokerOwner(effectiveProbeOptions)
        : { ok: false, error: "broker-unavailable", selected: null, attempts: [] };
    const ownerResolveWarning = probe.available && !ownerResolve.ok
        ? "host broker is reachable but does not satisfy the required owner-resolve contract; restart or upgrade the host broker so /v1/owner/resolve is available"
        : null;
    const ownerResolveRemedy = ownerResolveWarning
        ? "Update host CCC to a matching protocol and run ccc devices broker status on the physical host, then retry."
        : null;
    const runtime = readBrokerRuntime();
    const containerContract = brokerContainerContract();
    const launchIncompatible = launch?.error === "host-broker-incompatible";
    const ownerAuthAvailable = ownerResolve.ok && Boolean(ownerToken(ownerResolve.ownerId || owner));
    if (!probe.available || !ownerResolve.ok || !ownerAuthAvailable || launchIncompatible) invalidateBrokerSetup();
    const ownerAuthWarning = ownerResolve.ok && !ownerAuthAvailable
        ? "host broker is reachable but the resolved owner credential is unavailable"
        : null;
    const compatibilityWarning = launchIncompatible
        ? `host broker protocol mismatch; update host CCC and retry`
        : null;
    const warnings = [...containerContract.warnings, ...(ownerResolveWarning ? [ownerResolveWarning] : []), ...(compatibilityWarning ? [compatibilityWarning] : []), ...(ownerAuthWarning ? [ownerAuthWarning] : [])];
    const remedies = [...containerContract.remedies, ...(ownerResolveRemedy ? [ownerResolveRemedy] : []), ...(compatibilityWarning ? ["Restart or upgrade the host ccc device broker before using host-backed tools."] : []), ...(ownerAuthWarning ? ["Reopen CCC from the host to restore the isolated owner credential mount."] : [])];
    return {
        ownerId: owner,
        mode: launchIncompatible ? "broker-incompatible" : probe.available ? "host-broker-detected" : "broker-unavailable",
        lazy: true,
        available: probe.available && !launchIncompatible,
        rpcReady: ownerResolve.ok && ownerAuthAvailable && !launchIncompatible,
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
        protocolVersion: DEVICE_BROKER_PROTOCOL_VERSION,
        note: "Device backends remain lazy. Host ccc starts only the broker process for containers; it does not start emulators, simulators, sandboxes, VMs, Appium, or provider tools.",
    };
}

/** @param {import('./ports/device-request.mjs').BrokerResult} receipt
 * @returns {import('./ports/device-request.mjs').BrokerObservation} */
export function brokerObservation(receipt) {
    return {ok:receipt.ok === true, ...(receipt.selected ? {selection:receipt.selected} : {}), receipt};
}
export async function observeBrokerStatus(args) {
    const receipt = await brokerStatus(args);
    return {...brokerObservation(receipt), available:receipt.available};
}
export async function observeBrokerBackends(args) {
    const receipt = await brokerRpc({...args, method:'broker.backends'});
    const payload = receipt.result;
    return {...brokerObservation(receipt),backends:Array.isArray(payload?.backends) ? payload.backends : null,payloadReceipt:payload};
}
export async function observeBrokerInventory(args) {
    const receipt = await brokerRpc({...args, method:'broker.inventory'});
    const payload = receipt.result;
    return {...brokerObservation(receipt),backends:Array.isArray(payload?.backends) ? payload.backends : null,
        devices:Array.isArray(payload?.devices) ? payload.devices : null,payloadReceipt:payload};
}
export async function invokeBrokerLifecycle(args) { return brokerObservation(await brokerCommand(args)); }
export async function ensureMobileSession(args) { return brokerObservation(await brokerAppium({...args,action:'ensure-session'})); }
export async function observeMobileSessionStatus(args) { return brokerObservation(await brokerAppium({...args,action:'status'})); }

/** @param {unknown} value */
function decodeClipboardText(value) {
    if (typeof value !== 'string') return value;
    const normalized = value.trim();
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) || normalized.length % 4 === 1) return value;
    try {
        const decoded = Buffer.from(normalized,'base64').toString('utf8');
        return Buffer.from(decoded,'utf8').toString('base64').replace(/=+$/, '') === normalized.replace(/=+$/, '') ? decoded : value;
    } catch { return value; }
}
/** Native frames for one admitted effect; sequencing and budgets remain in application.
 * @param {import('./ports/device-request.mjs').DeviceArguments & {backend:string,deviceId:string}} args
 * @param {import('./domain/device-request.mjs').MobileEffect} effect
 * @returns {Promise<import('./ports/device-request.mjs').MobileObservation>} */
export async function executeMobileEffect(args, effect) {
    const post = (path,body) => ({method:'POST',path,body});
    const shell = (command,values) => post('/execute/sync',{script:'mobile: shell',args:[{command,args:values}]});
    const keycode = code => post('/appium/device/press_keycode',{keycode:code});
    const android = args.backend.startsWith('android');
    let frame;
    switch (effect.kind) {
    case 'read-source': frame={method:'GET',path:'/source'}; break;
    case 'capture-screenshot': frame={method:'GET',path:'/screenshot'}; break;
    case 'tap': case 'double-tap': case 'long-press': case 'swipe': case 'drag': {
        const move = {type:'pointerMove',duration:0,x:'x' in effect ? effect.x : effect.x1,y:'y' in effect ? effect.y : effect.y1};
        const down={type:'pointerDown',button:0}, up={type:'pointerUp',button:0};
        const steps=[move,down];
        if (effect.kind === 'long-press') steps.push({type:'pause',duration:effect.durationMs});
        if (effect.kind === 'swipe' || effect.kind === 'drag') steps.push({type:'pointerMove',duration:effect.durationMs,x:effect.x2,y:effect.y2});
        steps.push(up);
        if (effect.kind === 'double-tap') steps.push({type:'pause',duration:80},down,up);
        const id=effect.kind === 'double-tap' ? 'doubleTap' : effect.kind === 'long-press' ? 'longPress' : effect.kind;
        frame=post('/actions',{actions:[{type:'pointer',id,parameters:{pointerType:'touch'},actions:steps}]}); break;
    }
    case 'type-text': frame=post('/keys',{text:effect.text,value:[...effect.text]}); break;
    case 'send-key': frame=post('/keys',{text:effect.key,value:[effect.key]}); break;
    case 'send-key-code': frame=keycode(effect.keyCode); break;
    case 'back': frame=post('/back',{}); break;
    case 'home': frame=android ? keycode(3) : post('/execute/sync',{script:'mobile: pressButton',args:[{name:'home'}]}); break;
    case 'forward': frame=keycode(125); break;
    case 'recents': frame=keycode(187); break;
    case 'power': frame=keycode(26); break;
    case 'lock': case 'unlock': frame=android ? keycode(effect.kind === 'lock' ? 223 : 224) : post('/execute/sync',{script:'mobile: '+effect.kind,args:[]}); break;
    case 'set-orientation': frame=post('/orientation',{orientation:effect.orientation.toUpperCase()}); break;
    case 'set-automatic-rotation': frame=shell('settings',['put','system','accelerometer_rotation',effect.enabled ? '1' : '0']); break;
    case 'set-display-rotation': frame=shell('settings',['put','system','user_rotation',({'portrait':'0','landscape':'1','reverse-portrait':'2','reverse-landscape':'3'})[effect.orientation]]); break;
    case 'open-url': frame=post('/url',{url:effect.url}); break;
    case 'install-app': frame=post('/appium/device/install_app',{appPath:effect.path}); break;
    case 'launch-component': frame=shell('am',['start','-n',effect.component]); break;
    case 'launch-app': case 'uninstall-app': case 'stop-app': frame=post('/appium/device/'+({'launch-app':'activate_app','uninstall-app':'remove_app','stop-app':'terminate_app'})[effect.kind],{appId:effect.appId}); break;
    case 'clear-app-data': frame=shell('pm',['clear',effect.appId]); break;
    case 'set-location': frame=post('/location',{location:{latitude:effect.latitude,longitude:effect.longitude,altitude:effect.altitude}}); break;
    case 'set-airplane-mode-setting': frame=shell('settings',['put','global','airplane_mode_on',effect.enabled ? '1' : '0']); break;
    case 'announce-airplane-mode': frame=shell('am',['broadcast','-a','android.intent.action.AIRPLANE_MODE','--ez','state',effect.enabled ? 'true' : 'false']); break;
    case 'set-clipboard': frame=post('/appium/device/set_clipboard',{content:Buffer.from(effect.text,'utf8').toString('base64'),contentType:'plaintext',label:'text'}); break;
    case 'read-clipboard': frame=post('/appium/device/get_clipboard',{contentType:'plaintext'}); break;
    }
    const receipt=await brokerAppium({...args,action:'request',...frame});
    if (!receipt.ok) return {kind:'failed',localBudgetExhausted:isLocalObservationBudgetExhaustion(receipt),receipt};
    const body=receipt.result?.response?.body;
    const value=body?.value ?? body;
    const screenshot=body?.value ?? body?.screenshot;
    return {kind:'completed',receipt,
        ...(effect.kind === 'read-source' ? {source:value,sourceText:String(body?.value ?? '')} : {}),
        ...(effect.kind === 'read-clipboard' ? {clipboardText:decodeClipboardText(value)} : {}),
        ...(effect.kind === 'capture-screenshot' && screenshot ? {screenshotData:String(screenshot)} : {}),
    };
}
