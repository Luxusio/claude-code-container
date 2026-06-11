import { createHash } from "crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http";
import { homedir, hostname } from "os";
import { join } from "path";

export const DEVICE_BROKER_DEFAULT_HOST = "127.0.0.1";
export const DEVICE_BROKER_DEFAULT_PORT = 17373;
export const DEVICE_BROKER_NAME = "ccc-device-broker";
export const DEVICE_BROKER_RPC_BODY_LIMIT = 64 * 1024;
export const DEVICE_BROKER_INVENTORY_FILE_LIMIT = 256 * 1024;
export const DEVICE_BROKER_INVENTORY_DEVICE_LIMIT = 200;
const DEVICE_BROKER_BACKEND_STATE_KEYS = ["android", "android-device", "ios", "ios-device", "windows", "macos"];
const DEVICE_BROKER_PHYSICAL_BACKENDS = new Set(["android-device", "ios-device"]);
const LIFECYCLE_METHOD_RE = /^(device|mobile)\./;

export interface DeviceBrokerOptions {
    cwd?: string;
    host?: string;
    port?: number;
    startedAt?: string;
    ownerId?: string;
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

function brokerRoot(): string {
    return join(homedir(), ".ccc/devices");
}

function deviceBrokerOwnerId(cwd: string): string {
    return createHash("sha256").update(`${hostname()}:${cwd || "/project"}`).digest("hex").slice(0, 16);
}

export function deviceBrokerOwnerToken(ownerId: string): string {
    return createHash("sha256").update(`${DEVICE_BROKER_NAME}:owner:${ownerId}`).digest("hex");
}

function normalizeBrokerOptions(options: DeviceBrokerOptions = {}) {
    const cwd = options.cwd || process.cwd();
    const host = options.host || DEVICE_BROKER_DEFAULT_HOST;
    const port = Number.isInteger(options.port) ? Number(options.port) : DEVICE_BROKER_DEFAULT_PORT;
    const startedAt = options.startedAt || new Date().toISOString();
    return { cwd, host, port, startedAt };
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
        startupPolicy: "manual CLI serve in this slice; MCP auto-launch remains deferred",
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
            "owner-state-path-reporting",
            "zero-config-default-port",
        ],
        deferred: [
            "mcp-auto-launch",
            "mutating-backend-command-proxy",
            "strong-authentication-token-handshake",
            "real-device-connect-proxy",
            "daemon pidfile supervision",
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
