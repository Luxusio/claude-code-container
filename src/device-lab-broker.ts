import { createHash, randomBytes } from "crypto";
import { spawn, spawnSync } from "child_process";
import { accessSync, chmodSync, closeSync, constants as fsConstants, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http";
import { homedir, hostname } from "os";
import { join } from "path";

export const DEVICE_BROKER_DEFAULT_HOST = "127.0.0.1";
export const DEVICE_BROKER_DEFAULT_PORT = 17373;
export const DEVICE_BROKER_NAME = "ccc-device-broker";
export const DEVICE_BROKER_RPC_BODY_LIMIT = 64 * 1024;
export const DEVICE_BROKER_INVENTORY_FILE_LIMIT = 256 * 1024;
export const DEVICE_BROKER_INVENTORY_DEVICE_LIMIT = 200;
export const DEVICE_BROKER_COMMAND_TIMEOUT_MS = 5000;
export const DEVICE_BROKER_COMMAND_OUTPUT_LIMIT = 32 * 1024;
const DEVICE_BROKER_BACKEND_STATE_KEYS = ["android", "android-device", "ios", "ios-device", "windows", "macos"];
const DEVICE_BROKER_PHYSICAL_BACKENDS = new Set(["android-device", "ios-device"]);
const DEVICE_BROKER_MACOS_PROVIDERS = new Set(["tart", "vz", "utmctl"]);
const DEVICE_BROKER_COMMAND_BACKENDS = new Map([
    ["android-emulator", "android"],
    ["android-device", "android-device"],
    ["ios-simulator", "ios"],
    ["ios-device", "ios-device"],
    ["windows-sandbox", "windows"],
    ["macos-vm", "macos"],
]);
const DEVICE_BROKER_LIFECYCLE_COMMANDS = new Set(["device_status", "device_start", "device_stop", "device_delete"]);
const LIFECYCLE_METHOD_RE = /^(device|mobile)\./;

export interface DeviceBrokerOptions {
    cwd?: string;
    host?: string;
    port?: number;
    startedAt?: string;
    ownerId?: string;
    providerPaths?: Record<string, string>;
    commandTimeoutMs?: number;
    commandRunner?: ProviderCommandRunner;
}

type BrokerRpcResult = { status: number; payload: unknown };
type LeaseParamError = { ok: false; status: number; error: string; allowed?: string[] };
type LeaseParamSuccess = {
    ok: true;
    backend: string;
    hardwareId: string;
    deviceId: string | null;
    connection: string;
    transport: object;
};
type CommandParamError = { ok: false; status: number; error: string; allowed?: string[] };
type CommandParamSuccess = {
    ok: true;
    backend: string;
    stateKey: string;
    command: string;
    deviceId: string;
    force: boolean;
    dryRun: boolean;
};
type AttachParamError = { ok: false; status: number; error: string; allowed?: string[] };
type AttachParamSuccess = {
    ok: true;
    backend: string;
    stateKey: string;
    deviceId: string;
    name: string | null;
    serial: string | null;
    udid: string | null;
    connection: string;
    connectionProvided: boolean;
    host: string | null;
    port: number | null;
};
type ProviderCommand = {
    mode: "exec" | "detached" | "noop";
    provider: string;
    executable?: string;
    args?: string[];
    reason?: string;
};
type ProviderCommandResult = {
    mode: string;
    provider: string;
    executable?: string;
    args?: string[];
    status?: number | null;
    signal?: string | null;
    stdout?: string;
    stderr?: string;
    error?: string;
    pid?: number;
    timedOut?: boolean;
};
type ProviderCommandRunner = (command: ProviderCommand, options: { timeoutMs: number; outputLimit: number }) => ProviderCommandResult;

function brokerRoot(): string {
    return join(homedir(), ".ccc/devices");
}

function deviceBrokerOwnerId(cwd: string): string {
    return createHash("sha256").update(`${hostname()}:${cwd || "/project"}`).digest("hex").slice(0, 16);
}

export function deviceBrokerOwnerToken(ownerId: string): string {
    const secret = deviceBrokerOwnerSecret(ownerId);
    return createHash("sha256").update(`${DEVICE_BROKER_NAME}:owner:${ownerId}:secret:${secret}`).digest("hex");
}

export function deviceBrokerAuthSecretFile(ownerId: string): string {
    if (!/^[a-f0-9]{16}$/.test(ownerId)) throw new Error("invalid-owner-id");
    return join(brokerRoot(), "broker", "auth", `${ownerId}.json`);
}

export function deviceBrokerOwnerSecret(ownerId: string): string {
    const file = deviceBrokerAuthSecretFile(ownerId);
    try {
        if (existsSync(file)) {
            const parsed = JSON.parse(readFileSync(file, "utf8")) as { secret?: unknown };
            if (typeof parsed.secret === "string" && /^[a-f0-9]{64}$/.test(parsed.secret)) {
                try { chmodSync(file, 0o600); } catch { /* best effort on non-POSIX filesystems */ }
                return parsed.secret;
            }
        }
    } catch {
        // Replace unreadable/invalid auth metadata with a fresh owner secret.
    }
    const secret = randomBytes(32).toString("hex");
    mkdirSync(join(brokerRoot(), "broker", "auth"), { recursive: true });
    writeFileSync(file, JSON.stringify({
        ownerId,
        secret,
        createdAt: new Date().toISOString(),
        version: 1,
    }, null, 2), { mode: 0o600 });
    try { chmodSync(file, 0o600); } catch { /* best effort on non-POSIX filesystems */ }
    return secret;
}

function normalizeBrokerOptions(options: DeviceBrokerOptions = {}) {
    const cwd = options.cwd || process.cwd();
    const host = options.host || DEVICE_BROKER_DEFAULT_HOST;
    const port = Number.isInteger(options.port) ? Number(options.port) : DEVICE_BROKER_DEFAULT_PORT;
    const startedAt = options.startedAt || new Date().toISOString();
    const commandTimeoutMs = Number.isFinite(options.commandTimeoutMs)
        ? Math.min(30000, Math.max(1, Number(options.commandTimeoutMs)))
        : DEVICE_BROKER_COMMAND_TIMEOUT_MS;
    return {
        cwd,
        host,
        port,
        startedAt,
        providerPaths: options.providerPaths || {},
        commandTimeoutMs,
        commandRunner: options.commandRunner || defaultProviderCommandRunner,
    };
}

export function deviceBrokerStatus(options: DeviceBrokerOptions = {}) {
    const normalized = normalizeBrokerOptions(options);
    const ownerId = options.ownerId || deviceBrokerOwnerId(normalized.cwd);
    const root = brokerRoot();
    return {
        name: DEVICE_BROKER_NAME,
        host: normalized.host,
        port: normalized.port,
        url: `http://${normalized.host}:${normalized.port}`,
        ownerId,
        hostId: hostname(),
        mode: "host-broker-daemon",
        lazy: true,
        startupPolicy: "manual CLI serve or explicit MCP autolaunch; never starts device providers on daemon startup",
        startedAt: normalized.startedAt,
        state: {
            root,
            ownerRoot: join(root, "owners", ownerId),
            brokerRoot: join(root, "broker"),
            locksRoot: join(root, "broker", "locks"),
            logsRoot: join(root, "broker", "logs"),
        },
        implemented: [
            "http-health",
            "http-status",
            "http-owner-rpc",
            "owner-token-guard",
            "http-physical-lease-api",
            "http-physical-attach-api",
            "http-lifecycle-command-plan",
            "bounded-provider-command-execution",
            "explicit-mcp-autolaunch-compatible",
            "owner-state-path-reporting",
            "zero-config-default-port",
            "secret-backed-owner-token-auth",
        ],
        deferred: [
            "full-provider-routing-parity",
            "permanent-service-manager-supervision",
        ],
    };
}

function writeJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    const payload = JSON.stringify(body, null, 2);
    res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(payload),
        ...headers,
    });
    res.end(payload);
}

function readRequestJson(req: IncomingMessage, limit = DEVICE_BROKER_RPC_BODY_LIMIT): Promise<{ ok: true; body: unknown } | { ok: false; status: number; error: string }> {
    return new Promise((resolve) => {
        const chunks: Buffer[] = [];
        let total = 0;
        let resolved = false;

        function finish(result: { ok: true; body: unknown } | { ok: false; status: number; error: string }) {
            if (resolved) return;
            resolved = true;
            resolve(result);
        }

        req.on("data", (chunk: Buffer) => {
            total += chunk.length;
            if (total > limit) {
                finish({ ok: false, status: 413, error: "request-too-large" });
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            if (resolved) return;
            try {
                const text = Buffer.concat(chunks).toString("utf8");
                finish({ ok: true, body: text ? JSON.parse(text) : {} });
            } catch {
                finish({ ok: false, status: 400, error: "invalid-json" });
            }
        });
        req.on("error", () => finish({ ok: false, status: 400, error: "request-read-failed" }));
    });
}

function ownerInventory(ownerId: string) {
    const root = brokerRoot();
    const backends = DEVICE_BROKER_BACKEND_STATE_KEYS.map((stateKey) => {
        const file = join(root, "owners", ownerId, stateKey, "devices.json");
        if (!existsSync(file)) return { stateKey, devices: [], exists: false };
        try {
            const stat = statSync(file);
            if (stat.size > DEVICE_BROKER_INVENTORY_FILE_LIMIT) {
                return {
                    stateKey,
                    devices: [],
                    exists: true,
                    truncated: true,
                    error: "inventory-file-too-large",
                    maxBytes: DEVICE_BROKER_INVENTORY_FILE_LIMIT,
                    bytes: stat.size,
                };
            }
            const parsed = JSON.parse(readFileSync(file, "utf8")) as { devices?: unknown[] };
            const devices = Array.isArray(parsed.devices) ? parsed.devices : [];
            return {
                stateKey,
                devices: devices.slice(0, DEVICE_BROKER_INVENTORY_DEVICE_LIMIT),
                exists: true,
                truncated: devices.length > DEVICE_BROKER_INVENTORY_DEVICE_LIMIT,
                totalDevices: devices.length,
                maxDevices: DEVICE_BROKER_INVENTORY_DEVICE_LIMIT,
            };
        } catch (error) {
            return { stateKey, devices: [], exists: true, error: error instanceof Error ? error.message : String(error) };
        }
    });
    return {
        ownerId,
        root,
        ownerRoot: join(root, "owners", ownerId),
        backends,
    };
}

function ownerDevicesFile(ownerId: string, stateKey: string) {
    return join(brokerRoot(), "owners", ownerId, stateKey, "devices.json");
}

function readOwnerDevices(ownerId: string, stateKey: string) {
    const file = ownerDevicesFile(ownerId, stateKey);
    if (!existsSync(file)) return [];
    const stat = statSync(file);
    if (stat.size > DEVICE_BROKER_INVENTORY_FILE_LIMIT) {
        throw new Error("owner-devices-file-too-large");
    }
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { devices?: unknown[] };
    return Array.isArray(parsed.devices) ? parsed.devices : [];
}

function writeOwnerDevices(ownerId: string, stateKey: string, devices: unknown[]) {
    const file = ownerDevicesFile(ownerId, stateKey);
    mkdirSync(join(brokerRoot(), "owners", ownerId, stateKey), { recursive: true });
    writeFileSync(file, JSON.stringify({ devices }, null, 2), { mode: 0o600 });
}

function physicalLeaseLocksDir(backend: string) {
    return join(brokerRoot(), "physical-leases", backend, "locks");
}

function physicalLeaseLockFile(backend: string, hardwareId: string) {
    return join(physicalLeaseLocksDir(backend), `${encodeURIComponent(hardwareId)}.json`);
}

function validateLeaseParams(params: unknown, action: "claim" | "list" | "release"): LeaseParamError | LeaseParamSuccess {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
        return { ok: false, status: 400, error: "invalid-lease-params" };
    }
    const input = params as Record<string, unknown>;
    const backend = typeof input.backend === "string" ? input.backend : "";
    if (!DEVICE_BROKER_PHYSICAL_BACKENDS.has(backend)) {
        return { ok: false, status: 400, error: "invalid-lease-backend", allowed: [...DEVICE_BROKER_PHYSICAL_BACKENDS] };
    }
    if (input.all === true) {
        return { ok: false, status: 403, error: "all-owner-lease-list-requires-admin" };
    }
    const hardwareId = typeof input.hardwareId === "string" ? input.hardwareId.trim() : "";
    if (action !== "list" && (!hardwareId || hardwareId.length > 256 || /[\u0000-\u001f]/.test(hardwareId))) {
        return { ok: false, status: 400, error: "invalid-hardware-id" };
    }
    const deviceId = typeof input.deviceId === "string" ? input.deviceId.trim() : null;
    if (deviceId !== null && (!deviceId || deviceId.length > 128 || /[^a-zA-Z0-9._:-]/.test(deviceId))) {
        return { ok: false, status: 400, error: "invalid-device-id" };
    }
    const connection = typeof input.connection === "string" ? input.connection : "unknown";
    if (!["usb", "wifi", "unknown"].includes(connection)) {
        return { ok: false, status: 400, error: "invalid-connection" };
    }
    const transport = input.transport && typeof input.transport === "object" && !Array.isArray(input.transport)
        ? input.transport
        : {};
    return { ok: true, backend, hardwareId, deviceId, connection, transport };
}

function leaseParamError(parsed: LeaseParamError) {
    return {
        status: parsed.status,
        payload: {
            ok: false,
            error: parsed.error,
            ...(parsed.allowed ? { allowed: parsed.allowed } : {}),
        },
    };
}

function readLeaseFile(file: string) {
    try {
        return JSON.parse(readFileSync(file, "utf8"));
    } catch {
        return null;
    }
}

function listPhysicalLeases(ownerId: string, backend: string) {
    const locksDir = physicalLeaseLocksDir(backend);
    if (!existsSync(locksDir)) return [];
    return readdirSync(locksDir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => readLeaseFile(join(locksDir, name)))
        .filter((lease) => lease && lease.ownerId === ownerId);
}

function claimPhysicalLease(ownerId: string, params: unknown) {
    const parsed = validateLeaseParams(params, "claim");
    if (!parsed.ok) return leaseParamError(parsed);
    const now = new Date().toISOString();
    const lease = {
        backend: parsed.backend,
        hardwareId: parsed.hardwareId,
        ownerId,
        deviceId: parsed.deviceId,
        connection: parsed.connection,
        transport: parsed.transport,
        claimedAt: now,
        updatedAt: now,
    };
    mkdirSync(physicalLeaseLocksDir(parsed.backend), { recursive: true });
    const file = physicalLeaseLockFile(parsed.backend, parsed.hardwareId);
    try {
        const fd = openSync(file, "wx", 0o600);
        try {
            writeFileSync(fd, JSON.stringify(lease, null, 2));
        } finally {
            closeSync(fd);
        }
        return { status: 200, payload: { ok: true, result: { lease, created: true } } };
    } catch (error) {
        const existing = readLeaseFile(file);
        if (existing?.ownerId === ownerId) {
            return { status: 200, payload: { ok: true, result: { lease: existing, created: false, reused: true } } };
        }
        return {
            status: 409,
            payload: {
                ok: false,
                error: "physical-lease-conflict",
                conflict: existing || { backend: parsed.backend, hardwareId: parsed.hardwareId, ownerId: "unknown" },
            },
        };
    }
}

function releasePhysicalBrokerLease(ownerId: string, params: unknown) {
    const parsed = validateLeaseParams(params, "release");
    if (!parsed.ok) return leaseParamError(parsed);
    const file = physicalLeaseLockFile(parsed.backend, parsed.hardwareId);
    const existing = existsSync(file) ? readLeaseFile(file) : null;
    if (!existing) return { status: 404, payload: { ok: false, error: "physical-lease-not-found" } };
    if (existing.ownerId !== ownerId) {
        return { status: 403, payload: { ok: false, error: "physical-lease-owned-by-another-owner", conflict: existing } };
    }
    if (parsed.deviceId && existing.deviceId && existing.deviceId !== parsed.deviceId) {
        return { status: 409, payload: { ok: false, error: "physical-lease-device-mismatch", lease: existing } };
    }
    unlinkSync(file);
    return { status: 200, payload: { ok: true, result: { released: true, lease: existing } } };
}

function listPhysicalBrokerLeases(ownerId: string, params: unknown) {
    const parsed = validateLeaseParams(params, "list");
    if (!parsed.ok) return leaseParamError(parsed);
    return {
        status: 200,
        payload: {
            ok: true,
            result: {
                ownerId,
                backend: parsed.backend,
                leases: listPhysicalLeases(ownerId, parsed.backend),
            },
        },
    };
}

function validateAttachParams(params: unknown): AttachParamError | AttachParamSuccess {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
        return { ok: false, status: 400, error: "invalid-attach-params" };
    }
    const input = params as Record<string, unknown>;
    const backend = typeof input.backend === "string" ? input.backend : "";
    if (!DEVICE_BROKER_PHYSICAL_BACKENDS.has(backend)) {
        return { ok: false, status: 400, error: "invalid-attach-backend", allowed: [...DEVICE_BROKER_PHYSICAL_BACKENDS] };
    }
    const stateKey = backend;
    const name = typeof input.name === "string" && input.name.trim() ? input.name.trim() : null;
    const serial = typeof input.serial === "string" && input.serial.trim() ? input.serial.trim() : null;
    const udid = typeof input.udid === "string" && input.udid.trim() ? input.udid.trim() : null;
    const identity = backend === "android-device" ? serial || (typeof input.host === "string" ? input.host : null) : udid;
    const deviceId = typeof input.deviceId === "string" && input.deviceId.trim()
        ? input.deviceId.trim()
        : `${backend}-${createHash("sha256").update(String(identity || name || "real-device")).digest("hex").slice(0, 10)}`;
    if (!deviceId || deviceId.length > 128 || /[^a-zA-Z0-9._:-]/.test(deviceId)) {
        return { ok: false, status: 400, error: "invalid-device-id" };
    }
    const connectionProvided = typeof input.connection === "string";
    const connection = connectionProvided ? String(input.connection) : "usb";
    if (!["usb", "wifi"].includes(connection)) return { ok: false, status: 400, error: "invalid-connection" };
    const host = typeof input.host === "string" && input.host.trim() ? input.host.trim() : null;
    const port = Number.isFinite(input.port) ? Number(input.port) : null;
    return { ok: true, backend, stateKey, deviceId, name, serial, udid, connection, connectionProvided, host, port };
}

function attachParamError(parsed: AttachParamError) {
    return {
        status: parsed.status,
        payload: {
            ok: false,
            error: parsed.error,
            ...(parsed.allowed ? { allowed: parsed.allowed } : {}),
        },
    };
}

function parseAdbDevices(text: string) {
    return String(text || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("List of devices"))
        .map((line) => {
            const [serial, state, ...detailParts] = line.split(/\s+/);
            const details = Object.fromEntries(detailParts.map((part) => {
                const index = part.indexOf(":");
                return index > 0 ? [part.slice(0, index), part.slice(index + 1)] : [part, true];
            }));
            return { serial, state: state || "unknown", details };
        })
        .filter((device) => device.serial);
}

function parseXctraceDevices(text: string) {
    return String(text || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.endsWith(":") && !line.includes("Simulator"))
        .map((line) => {
            const matches = [...line.matchAll(/\(([^()]*)\)/g)].map((match) => match[1]);
            const udid = matches.find((value) => /^[A-Fa-f0-9-]{8,}$/.test(value));
            if (!udid) return null;
            const version = matches.find((value) => value !== udid && /\d/.test(value)) || null;
            const name = line.split(" (")[0].trim();
            if (!/\b(iPhone|iPad|iPod)\b/i.test(name)) return null;
            const connection = /\b(network|wifi|wi-fi)\b/i.test(line) ? "wifi" : "usb";
            return { name, udid, version, connection, raw: line };
        })
        .filter(Boolean) as Array<{ name: string; udid: string; version: string | null; connection: string; raw: string }>;
}

function existingPhysicalDevice(ownerId: string, stateKey: string, deviceId: string, hardwareId: string, hardwareField: "serial" | "udid") {
    return readOwnerDevices(ownerId, stateKey).find((device) => {
        if (!device || typeof device !== "object") return false;
        const candidate = device as Record<string, unknown>;
        return candidate.id === deviceId || candidate[hardwareField] === hardwareId;
    });
}

function brokerAttachAndroid(ownerId: string, parsed: AttachParamSuccess, normalized: ReturnType<typeof normalizeBrokerOptions>) {
    const adb = executableFor("adb", normalized);
    if (parsed.connection === "wifi" && !parsed.host && !parsed.serial) {
        return { status: 400, payload: { ok: false, error: "missing-android-wifi-target" } };
    }
    const target = parsed.connection === "wifi"
        ? (parsed.serial?.includes(":") ? parsed.serial : `${parsed.host || parsed.serial}:${parsed.port || 5555}`)
        : parsed.serial;
    if (!target || target.startsWith("emulator-")) {
        return { status: 400, payload: { ok: false, error: target?.startsWith("emulator-") ? "android-emulator-not-physical-device" : "missing-android-serial" } };
    }
    if (existingPhysicalDevice(ownerId, parsed.stateKey, parsed.deviceId, target, "serial")) {
        return { status: 409, payload: { ok: false, error: "owner-device-already-attached", deviceId: parsed.deviceId, hardwareId: target } };
    }
    const lease = claimPhysicalLease(ownerId, {
        backend: parsed.backend,
        hardwareId: target,
        deviceId: parsed.deviceId,
        connection: parsed.connection,
        transport: parsed.connection === "wifi" ? { type: "wifi", host: parsed.host || target.split(":")[0], port: Number(target.split(":")[1] || parsed.port || 5555) } : { type: "usb" },
    });
    if (lease.status !== 200) return lease;
    const leasePayload = lease.payload as { result?: { lease?: unknown } };
    if (parsed.connection === "wifi") {
        const connect = normalized.commandRunner({ mode: "exec", provider: "adb", executable: adb, args: ["connect", target] }, {
            timeoutMs: normalized.commandTimeoutMs,
            outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
        });
        if (!commandSucceeded(connect)) {
            releasePhysicalBrokerLease(ownerId, { backend: parsed.backend, hardwareId: target, deviceId: parsed.deviceId });
            return { status: 502, payload: { ok: false, error: "adb-connect-failed", command: connect } };
        }
    }
    const inventory = normalized.commandRunner({ mode: "exec", provider: "adb", executable: adb, args: ["devices", "-l"] }, {
        timeoutMs: normalized.commandTimeoutMs,
        outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
    });
    if (!commandSucceeded(inventory)) {
        releasePhysicalBrokerLease(ownerId, { backend: parsed.backend, hardwareId: target, deviceId: parsed.deviceId });
        return { status: 502, payload: { ok: false, error: "adb-inventory-failed", command: inventory } };
    }
    const hostDevice = parseAdbDevices(inventory.stdout || "").find((device) => device.serial === target);
    if (!hostDevice) {
        releasePhysicalBrokerLease(ownerId, { backend: parsed.backend, hardwareId: target, deviceId: parsed.deviceId });
        return { status: 404, payload: { ok: false, error: "android-device-not-visible", hardwareId: target, command: inventory } };
    }
    if (hostDevice.state !== "device") {
        releasePhysicalBrokerLease(ownerId, { backend: parsed.backend, hardwareId: target, deviceId: parsed.deviceId });
        return { status: 409, payload: { ok: false, error: "android-device-not-attachable", hardwareId: target, state: hostDevice.state } };
    }
    const now = new Date().toISOString();
    const device = {
        id: parsed.deviceId,
        name: parsed.name || target,
        backend: "android-device",
        kind: "mobile",
        platform: "android",
        physical: true,
        ownerId,
        serial: target,
        connection: parsed.connection,
        transport: parsed.connection === "wifi" ? { type: "wifi", host: parsed.host || target.split(":")[0], port: Number(target.split(":")[1] || parsed.port || 5555) } : { type: "usb", host: null, port: null },
        hostDetails: hostDevice.details,
        status: "attached",
        creatable: false,
        attachable: true,
        attachedAt: now,
        updatedAt: now,
    };
    try {
        writeOwnerDevices(ownerId, parsed.stateKey, [...readOwnerDevices(ownerId, parsed.stateKey), device]);
    } catch (error) {
        releasePhysicalBrokerLease(ownerId, { backend: parsed.backend, hardwareId: target, deviceId: parsed.deviceId });
        return { status: 500, payload: { ok: false, error: "owner-state-write-failed", detail: error instanceof Error ? error.message : String(error) } };
    }
    return { status: 200, payload: { ok: true, result: { device, lease: leasePayload.result?.lease, provider: "adb", inventory } } };
}

function brokerAttachIos(ownerId: string, parsed: AttachParamSuccess, normalized: ReturnType<typeof normalizeBrokerOptions>) {
    if (!parsed.udid) return { status: 400, payload: { ok: false, error: "missing-ios-udid" } };
    if (existingPhysicalDevice(ownerId, parsed.stateKey, parsed.deviceId, parsed.udid, "udid")) {
        return { status: 409, payload: { ok: false, error: "owner-device-already-attached", deviceId: parsed.deviceId, hardwareId: parsed.udid } };
    }
    const xcrun = executableFor("xcrun", normalized);
    const inventory = normalized.commandRunner({ mode: "exec", provider: "xcrun", executable: xcrun, args: ["xctrace", "list", "devices"] }, {
        timeoutMs: normalized.commandTimeoutMs,
        outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
    });
    if (!commandSucceeded(inventory)) return { status: 502, payload: { ok: false, error: "xctrace-inventory-failed", command: inventory } };
    const hostDevice = parseXctraceDevices(inventory.stdout || "").find((device) => device.udid === parsed.udid);
    if (!hostDevice) return { status: 404, payload: { ok: false, error: "ios-device-not-visible", hardwareId: parsed.udid, command: inventory } };
    if (parsed.connection === "wifi" && hostDevice.connection !== "wifi") {
        return { status: 409, payload: { ok: false, error: "ios-wifi-device-not-network-visible", hardwareId: parsed.udid } };
    }
    const connection = parsed.connectionProvided ? parsed.connection : hostDevice.connection;
    const lease = claimPhysicalLease(ownerId, {
        backend: parsed.backend,
        hardwareId: parsed.udid,
        deviceId: parsed.deviceId,
        connection,
        transport: { type: connection, host: connection === "wifi" ? parsed.host : null, port: connection === "wifi" ? parsed.port : null, visibleVia: "xctrace" },
    });
    if (lease.status !== 200) return lease;
    const leasePayload = lease.payload as { result?: { lease?: unknown } };
    const now = new Date().toISOString();
    const device = {
        id: parsed.deviceId,
        name: parsed.name || hostDevice.name || parsed.udid,
        backend: "ios-device",
        kind: "mobile",
        platform: "ios",
        physical: true,
        ownerId,
        udid: parsed.udid,
        connection,
        transport: { type: connection, host: connection === "wifi" ? parsed.host : null, port: connection === "wifi" ? parsed.port : null, visibleVia: "xctrace" },
        hostDetails: hostDevice,
        status: "attached",
        creatable: false,
        attachable: true,
        attachedAt: now,
        updatedAt: now,
    };
    try {
        writeOwnerDevices(ownerId, parsed.stateKey, [...readOwnerDevices(ownerId, parsed.stateKey), device]);
    } catch (error) {
        releasePhysicalBrokerLease(ownerId, { backend: parsed.backend, hardwareId: parsed.udid, deviceId: parsed.deviceId });
        return { status: 500, payload: { ok: false, error: "owner-state-write-failed", detail: error instanceof Error ? error.message : String(error) } };
    }
    return { status: 200, payload: { ok: true, result: { device, lease: leasePayload.result?.lease, provider: "xcrun", inventory } } };
}

function attachPhysicalDevice(ownerId: string, params: unknown, normalized: ReturnType<typeof normalizeBrokerOptions>) {
    const parsed = validateAttachParams(params);
    if (!parsed.ok) return attachParamError(parsed);
    return parsed.backend === "android-device"
        ? brokerAttachAndroid(ownerId, parsed, normalized)
        : brokerAttachIos(ownerId, parsed, normalized);
}

function detachPhysicalDevice(ownerId: string, params: unknown) {
    const parsed = validateAttachParams(params);
    if (!parsed.ok) return attachParamError(parsed);
    const input = params as Record<string, unknown>;
    if (typeof input.deviceId !== "string" || !input.deviceId.trim()) {
        return { status: 400, payload: { ok: false, error: "invalid-device-id" } };
    }
    const devices = readOwnerDevices(ownerId, parsed.stateKey);
    const device = devices.find((candidate) => candidate && typeof candidate === "object" && (candidate as { id?: unknown }).id === parsed.deviceId) as Record<string, unknown> | undefined;
    if (!device) return { status: 404, payload: { ok: false, error: "owner-device-not-found", deviceId: parsed.deviceId } };
    const hardwareId = parsed.backend === "android-device" ? String(device.serial || "") : String(device.udid || "");
    if (hardwareId) releasePhysicalBrokerLease(ownerId, { backend: parsed.backend, hardwareId, deviceId: parsed.deviceId });
    writeOwnerDevices(ownerId, parsed.stateKey, devices.filter((candidate) => !(candidate && typeof candidate === "object" && (candidate as { id?: unknown }).id === parsed.deviceId)));
    return { status: 200, payload: { ok: true, result: { detached: parsed.deviceId, device, physicalDevicePoweredOff: false, disconnected: false } } };
}

function listAttachedPhysicalDevices(ownerId: string, params: unknown) {
    const parsed = validateLeaseParams(params, "list");
    if (!parsed.ok) return leaseParamError(parsed);
    return { status: 200, payload: { ok: true, result: { ownerId, backend: parsed.backend, devices: readOwnerDevices(ownerId, parsed.backend), leases: listPhysicalLeases(ownerId, parsed.backend) } } };
}

function validateCommandParams(params: unknown): CommandParamError | CommandParamSuccess {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
        return { ok: false, status: 400, error: "invalid-command-params" };
    }
    const input = params as Record<string, unknown>;
    const backend = typeof input.backend === "string" ? input.backend : "";
    const stateKey = DEVICE_BROKER_COMMAND_BACKENDS.get(backend);
    if (!stateKey) {
        return { ok: false, status: 400, error: "invalid-command-backend", allowed: [...DEVICE_BROKER_COMMAND_BACKENDS.keys()] };
    }
    const command = typeof input.command === "string" ? input.command : "";
    if (!DEVICE_BROKER_LIFECYCLE_COMMANDS.has(command)) {
        return { ok: false, status: 400, error: "unsupported-lifecycle-command", allowed: [...DEVICE_BROKER_LIFECYCLE_COMMANDS] };
    }
    const deviceId = typeof input.deviceId === "string" ? input.deviceId.trim() : "";
    if (!deviceId || deviceId.length > 128 || /[^a-zA-Z0-9._:-]/.test(deviceId)) {
        return { ok: false, status: 400, error: "invalid-device-id" };
    }
    const dryRun = input.dryRun === true;
    return { ok: true, backend, stateKey, command, deviceId, force: input.force === true, dryRun };
}

function commandParamError(parsed: CommandParamError) {
    return {
        status: parsed.status,
        payload: {
            ok: false,
            error: parsed.error,
            ...(parsed.allowed ? { allowed: parsed.allowed } : {}),
        },
    };
}

function field(device: unknown, name: string): string | null {
    if (!device || typeof device !== "object") return null;
    const value = (device as Record<string, unknown>)[name];
    return typeof value === "string" && value ? value : null;
}

function numberField(device: unknown, name: string): number | null {
    if (!device || typeof device !== "object") return null;
    const value = (device as Record<string, unknown>)[name];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function executableFor(provider: string, normalized: ReturnType<typeof normalizeBrokerOptions>) {
    return normalized.providerPaths[provider] || provider;
}

function androidSerial(device: unknown) {
    return field(device, "serial") || (numberField(device, "port") ? `emulator-${numberField(device, "port")}` : null);
}

function providerCommandFor(parsed: CommandParamSuccess, device: unknown, normalized: ReturnType<typeof normalizeBrokerOptions>): ProviderCommand | { error: string; missing: string[] } {
    if (parsed.backend === "android-emulator") {
        const adb = executableFor("adb", normalized);
        const emulator = executableFor("emulator", normalized);
        const avdmanager = executableFor("avdmanager", normalized);
        const serial = androidSerial(device);
        const avdName = field(device, "avdName");
        if (parsed.command === "device_status") {
            if (!serial) return { error: "missing-provider-metadata", missing: ["serial or port"] };
            return { mode: "exec", provider: "adb", executable: adb, args: ["-s", serial, "get-state"] };
        }
        if (parsed.command === "device_stop") {
            if (!serial) return { error: "missing-provider-metadata", missing: ["serial or port"] };
            return { mode: "exec", provider: "adb", executable: adb, args: ["-s", serial, "emu", "kill"] };
        }
        if (parsed.command === "device_delete") {
            if (!avdName) return { error: "missing-provider-metadata", missing: ["avdName"] };
            return { mode: "exec", provider: "avdmanager", executable: avdmanager, args: ["delete", "avd", "--name", avdName] };
        }
        if (!avdName) return { error: "missing-provider-metadata", missing: ["avdName"] };
        const port = numberField(device, "port");
        return { mode: "detached", provider: "emulator", executable: emulator, args: ["-avd", avdName, ...(port ? ["-port", String(port)] : [])] };
    }

    if (parsed.backend === "android-device") {
        const serial = field(device, "serial");
        if ((parsed.command === "device_status" || parsed.command === "device_start") && serial) {
            return { mode: "exec", provider: "adb", executable: executableFor("adb", normalized), args: ["-s", serial, "get-state"] };
        }
        if (parsed.command === "device_status" || parsed.command === "device_start") return { error: "missing-provider-metadata", missing: ["serial"] };
        return { mode: "noop", provider: "android-device", reason: "physical Android stop/delete does not power off or disconnect the real device" };
    }

    if (parsed.backend === "ios-simulator") {
        const target = field(device, "udid") || field(device, "simulatorName");
        if (!target) return { error: "missing-provider-metadata", missing: ["udid or simulatorName"] };
        const xcrun = executableFor("xcrun", normalized);
        if (parsed.command === "device_status") return { mode: "exec", provider: "xcrun", executable: xcrun, args: ["simctl", "list", "devices", target] };
        if (parsed.command === "device_start") return { mode: "exec", provider: "xcrun", executable: xcrun, args: ["simctl", "boot", target] };
        if (parsed.command === "device_stop") return { mode: "exec", provider: "xcrun", executable: xcrun, args: ["simctl", "shutdown", target] };
        return { mode: "exec", provider: "xcrun", executable: xcrun, args: ["simctl", "delete", target] };
    }

    if (parsed.backend === "ios-device") {
        const udid = field(device, "udid");
        if (parsed.command === "device_status" || parsed.command === "device_start") {
            if (!udid) return { error: "missing-provider-metadata", missing: ["udid"] };
            return { mode: "exec", provider: "xcrun", executable: executableFor("xcrun", normalized), args: ["devicectl", "device", "info", "details", "--device", udid] };
        }
        return { mode: "noop", provider: "ios-device", reason: "physical iOS stop/delete does not power off, erase, or disconnect the real device" };
    }

    if (parsed.backend === "windows-sandbox") {
        if (parsed.command === "device_status" || parsed.command === "device_delete") {
            return { mode: "noop", provider: "wsb", reason: "Windows Sandbox status/delete is represented by owner state in this broker layer" };
        }
        const wsb = executableFor("wsb", normalized);
        if (parsed.command === "device_stop") return { mode: "exec", provider: "wsb", executable: wsb, args: ["stop"] };
        const configPath = field(device, "configPath") || field(device, "wsbConfigPath");
        if (!configPath) return { error: "missing-provider-metadata", missing: ["configPath"] };
        return { mode: "exec", provider: "wsb", executable: wsb, args: ["start", configPath] };
    }

    if (parsed.backend === "macos-vm") {
        const provider = field(device, "provider") === "auto" || !field(device, "provider") ? "tart" : field(device, "provider") || "tart";
        if (!DEVICE_BROKER_MACOS_PROVIDERS.has(provider)) {
            return { error: "unsupported-provider-command", missing: ["provider"] };
        }
        const instance = field(device, "providerInstance");
        if (!instance) return { error: "missing-provider-metadata", missing: ["providerInstance"] };
        const executable = executableFor(provider, normalized);
        if (parsed.command === "device_status") return { mode: "exec", provider, executable, args: provider === "tart" ? ["get", instance] : ["status", instance] };
        if (parsed.command === "device_start") return { mode: "exec", provider, executable, args: ["start", instance] };
        if (parsed.command === "device_stop") return { mode: "exec", provider, executable, args: ["stop", instance] };
        return { mode: "exec", provider, executable, args: ["delete", instance] };
    }

    return { error: "unsupported-provider-command", missing: [] };
}

function truncateOutput(value: unknown, limit: number) {
    const text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value || "");
    return text.length > limit ? text.slice(0, limit) : text;
}

function executableExists(executable: string) {
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

function defaultProviderCommandRunner(command: ProviderCommand, options: { timeoutMs: number; outputLimit: number }): ProviderCommandResult {
    if (command.mode === "noop") {
        return { mode: "noop", provider: command.provider, stdout: command.reason || "", stderr: "", status: 0 };
    }
    if (!command.executable) {
        return { mode: command.mode, provider: command.provider, error: "missing-executable", status: null };
    }
    if (command.mode === "detached") {
        if (!executableExists(command.executable)) {
            return { mode: "detached", provider: command.provider, executable: command.executable, args: command.args || [], status: null, error: "executable-not-found" };
        }
        try {
            const child = spawn(command.executable, command.args || [], { detached: true, stdio: "ignore" });
            child.once("error", () => undefined);
            child.unref();
            return { mode: "detached", provider: command.provider, executable: command.executable, args: command.args || [], pid: child.pid, status: 0 };
        } catch (error) {
            return { mode: "detached", provider: command.provider, executable: command.executable, args: command.args || [], status: null, error: error instanceof Error ? error.message : String(error) };
        }
    }
    const result = spawnSync(command.executable, command.args || [], {
        encoding: "utf8",
        timeout: options.timeoutMs,
        maxBuffer: options.outputLimit,
    });
    return {
        mode: "exec",
        provider: command.provider,
        executable: command.executable,
        args: command.args || [],
        status: result.status,
        signal: result.signal,
        stdout: truncateOutput(result.stdout, options.outputLimit),
        stderr: truncateOutput(result.stderr, options.outputLimit),
        error: result.error ? result.error.message : undefined,
        timedOut: result.error?.message?.includes("ETIMEDOUT"),
    };
}

function commandSucceeded(result: ProviderCommandResult) {
    return result.status === 0 && !result.error;
}

function mutateDeviceAfterCommand(ownerId: string, parsed: CommandParamSuccess, device: unknown) {
    if (parsed.command === "device_status") return device;
    const devices = readOwnerDevices(ownerId, parsed.stateKey);
    if (parsed.command === "device_delete") {
        writeOwnerDevices(ownerId, parsed.stateKey, devices.filter((candidate) => {
            return !(candidate && typeof candidate === "object" && (candidate as { id?: unknown }).id === parsed.deviceId);
        }));
        return null;
    }
    const status = parsed.command === "device_start" ? "running" : "stopped";
    let updated: unknown = null;
    writeOwnerDevices(ownerId, parsed.stateKey, devices.map((candidate) => {
        if (candidate && typeof candidate === "object" && (candidate as { id?: unknown }).id === parsed.deviceId) {
            updated = { ...(candidate as object), status, updatedAt: new Date().toISOString() };
            return updated;
        }
        return candidate;
    }));
    return updated || device;
}

function lifecycleCommandPlan(ownerId: string, params: unknown, normalized?: ReturnType<typeof normalizeBrokerOptions>) {
    const parsed = validateCommandParams(params);
    if (!parsed.ok) return commandParamError(parsed);
    let devices: unknown[];
    try {
        devices = readOwnerDevices(ownerId, parsed.stateKey);
    } catch (error) {
        return { status: 413, payload: { ok: false, error: "owner-devices-file-too-large", backend: parsed.backend, stateKey: parsed.stateKey } };
    }
    const device = devices.find((candidate) => {
        return candidate && typeof candidate === "object" && (candidate as { id?: unknown }).id === parsed.deviceId;
    });
    if (!device) {
        return {
            status: 404,
            payload: {
                ok: false,
                error: "owner-device-not-found",
                ownerId,
                backend: parsed.backend,
                deviceId: parsed.deviceId,
            },
        };
    }
    return {
        status: 200,
        payload: {
            ok: true,
            result: {
                ownerId,
                backend: parsed.backend,
                stateKey: parsed.stateKey,
                command: parsed.command,
                deviceId: parsed.deviceId,
                force: parsed.force,
                dryRun: parsed.dryRun,
                device,
                providerCommand: normalized ? providerCommandFor(parsed, device, normalized) : null,
                execution: {
                    mode: "planned",
                    providerExecution: normalized ? "available" : "deferred",
                    mutatesHost: false,
                },
            },
        },
    };
}

function lifecycleCommandInvoke(ownerId: string, params: unknown, normalized: ReturnType<typeof normalizeBrokerOptions>) {
    const parsed = validateCommandParams(params);
    if (!parsed.ok) return commandParamError(parsed);
    const plan = lifecycleCommandPlan(ownerId, params, normalized);
    if (plan.status !== 200) return plan;
    const payload = plan.payload as { result?: { device?: unknown; providerCommand?: ProviderCommand | { error: string; missing: string[] } } };
    if (parsed.dryRun) {
        return {
            status: 200,
            payload: {
                ok: true,
                result: {
                    ...(payload.result || {}),
                    invoked: false,
                    dryRun: true,
                    execution: {
                        mode: "dry-run",
                        providerExecution: "available",
                        mutatesHost: false,
                    },
                },
            },
        };
    }
    const providerCommand = payload.result?.providerCommand;
    if (!providerCommand || "error" in providerCommand) {
        return {
            status: 400,
            payload: {
                ok: false,
                error: providerCommand?.error || "missing-provider-command",
                missing: providerCommand?.missing || [],
                plan: payload.result || null,
            },
        };
    }
    const execution = normalized.commandRunner(providerCommand, {
        timeoutMs: normalized.commandTimeoutMs,
        outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
    });
    const success = commandSucceeded(execution);
    const updatedDevice = success ? mutateDeviceAfterCommand(ownerId, parsed, payload.result?.device) : payload.result?.device;
    return {
        status: success ? 200 : 502,
        payload: {
            ok: success,
            ...(success ? {} : { error: "provider-command-failed" }),
            result: {
                ...(payload.result || {}),
                device: updatedDevice,
                invoked: true,
                dryRun: false,
                execution: {
                    mode: execution.mode,
                    providerExecution: "executed",
                    mutatesHost: success && parsed.command !== "device_status",
                    command: execution,
                },
            },
        },
    };
}

function handleBrokerRpc(ownerId: string, body: unknown, normalized: ReturnType<typeof normalizeBrokerOptions>, startedAt: string): BrokerRpcResult {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return { status: 400, payload: { ok: false, error: "invalid-rpc-body" } };
    }
    const rpc = body as { method?: unknown; params?: unknown; ownerId?: unknown };
    const method = typeof rpc.method === "string" ? rpc.method : "";
    if (rpc.ownerId !== undefined && rpc.ownerId !== ownerId) {
        return { status: 403, payload: { ok: false, error: "owner-mismatch", ownerId } };
    }
    if (!method) return { status: 400, payload: { ok: false, error: "missing-method" } };
    if (LIFECYCLE_METHOD_RE.test(method)) {
        return {
            status: 501,
            payload: {
                ok: false,
                error: "method-not-implemented",
                method,
                deferred: "mutating backend command proxy is intentionally not implemented in this broker transport slice",
            },
        };
    }
    if (method === "broker.status") {
        return { status: 200, payload: { ok: true, result: deviceBrokerStatus({ ...normalized, startedAt, ownerId }) } };
    }
    if (method === "broker.inventory") {
        return { status: 200, payload: { ok: true, result: ownerInventory(ownerId) } };
    }
    if (method === "broker.echo") {
        return { status: 200, payload: { ok: true, result: { ownerId, params: rpc.params ?? null } } };
    }
    if (method === "broker.lease.claim") return claimPhysicalLease(ownerId, rpc.params);
    if (method === "broker.lease.list") return listPhysicalBrokerLeases(ownerId, rpc.params);
    if (method === "broker.lease.release") return releasePhysicalBrokerLease(ownerId, rpc.params);
    if (method === "broker.physical.attach") return attachPhysicalDevice(ownerId, rpc.params, normalized);
    if (method === "broker.physical.detach") return detachPhysicalDevice(ownerId, rpc.params);
    if (method === "broker.physical.list") return listAttachedPhysicalDevices(ownerId, rpc.params);
    if (method === "broker.command.plan") return lifecycleCommandPlan(ownerId, rpc.params, normalized);
    if (method === "broker.command.invoke") return lifecycleCommandInvoke(ownerId, rpc.params, normalized);
    return { status: 404, payload: { ok: false, error: "unknown-method", method } };
}

function authorizeBrokerRpc(req: IncomingMessage, ownerId: string): { ok: true } | { ok: false; status: number; error: string } {
    const token = req.headers["x-ccc-device-token"];
    if (token !== deviceBrokerOwnerToken(ownerId)) {
        return { ok: false, status: 401, error: "invalid-owner-token" };
    }
    return { ok: true };
}

export function createDeviceBrokerServer(options: DeviceBrokerOptions = {}): Server {
    const normalized = normalizeBrokerOptions(options);
    const startedAt = normalized.startedAt;
    return createServer(async (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url || "/", `http://${req.headers.host || `${normalized.host}:${normalized.port}`}`);
        if (url.pathname === "/health") {
            if (req.method !== "GET") {
                writeJson(res, 405, { ok: false, error: "method-not-allowed" }, { allow: "GET" });
                return;
            }
            writeJson(res, 200, {
                ok: true,
                name: DEVICE_BROKER_NAME,
                mode: "host-broker-daemon",
                uptimeMs: Date.now() - Date.parse(startedAt),
            });
            return;
        }
        if (url.pathname === "/status") {
            if (req.method !== "GET") {
                writeJson(res, 405, { ok: false, error: "method-not-allowed" }, { allow: "GET" });
                return;
            }
            writeJson(res, 200, {
                ok: true,
                broker: deviceBrokerStatus({ ...normalized, startedAt }),
            });
            return;
        }
        const ownerRpcMatch = /^\/v1\/owners\/([^/]+)\/rpc$/.exec(url.pathname);
        if (ownerRpcMatch) {
            if (req.method !== "POST") {
                writeJson(res, 405, { ok: false, error: "method-not-allowed" }, { allow: "POST" });
                return;
            }
            const ownerId = decodeURIComponent(ownerRpcMatch[1]);
            if (!/^[a-f0-9]{16}$/.test(ownerId)) {
                writeJson(res, 400, { ok: false, error: "invalid-owner-id" });
                return;
            }
            const auth = authorizeBrokerRpc(req, ownerId);
            if (!auth.ok) {
                writeJson(res, auth.status, { ok: false, error: auth.error });
                return;
            }
            const body = await readRequestJson(req);
            if (!body.ok) {
                writeJson(res, body.status, { ok: false, error: body.error });
                return;
            }
            const result = handleBrokerRpc(ownerId, body.body, normalized, startedAt);
            writeJson(res, result.status, result.payload);
            return;
        }
        if (req.method !== "GET") {
            writeJson(res, 405, { ok: false, error: "method-not-allowed" }, { allow: "GET" });
            return;
        }
        writeJson(res, 404, { ok: false, error: "not-found", path: url.pathname });
    });
}

export function formatDeviceBrokerStatus(options: DeviceBrokerOptions = {}): string {
    const status = deviceBrokerStatus(options);
    const lines = [
        "=== CCC Device Broker ===",
        "",
        `name: ${status.name}`,
        `mode: ${status.mode}`,
        `host: ${status.host}`,
        `port: ${status.port}`,
        `url: ${status.url}`,
        `owner: ${status.ownerId}`,
        `state: ${status.state.root}`,
        `startup: ${status.startupPolicy}`,
        `implemented: ${status.implemented.join(", ")}`,
        `deferred: ${status.deferred.join(", ")}`,
    ];
    return `${lines.join("\n")}\n`;
}

export function parseBrokerServeArgs(args: string[]): { host: string; port: number } {
    let host = DEVICE_BROKER_DEFAULT_HOST;
    let port = DEVICE_BROKER_DEFAULT_PORT;
    for (let i = 0; i < args.length; i += 1) {
        if (args[i] === "--host" && args[i + 1]) {
            host = args[i + 1];
            i += 1;
        } else if (args[i] === "--port" && args[i + 1]) {
            port = Number(args[i + 1]);
            i += 1;
        }
    }
    return { host, port: Number.isInteger(port) ? port : DEVICE_BROKER_DEFAULT_PORT };
}

export function startDeviceBrokerServe(
    args: string[],
    cwd = process.cwd(),
    serverFactory = createDeviceBrokerServer,
): number {
    const { host, port } = parseBrokerServeArgs(args);
    const startedAt = new Date().toISOString();
    const server = serverFactory({ cwd, host, port, startedAt });
    server.listen(port, host, () => {
        console.log(`ccc-device-broker listening on http://${host}:${port}`);
    });
    return 0;
}

export function deviceBrokerCli(args: string[], cwd = process.cwd()): number {
    const command = args[0] || "status";
    if (command === "status") {
        console.log(formatDeviceBrokerStatus({ cwd }));
        return 0;
    }
    if (command === "serve") {
        return startDeviceBrokerServe(args.slice(1), cwd);
    }
    console.error("Usage: ccc devices broker <status|serve> [--host HOST] [--port PORT]");
    return 1;
}
