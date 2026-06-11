import { createHash } from "crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http";
import { homedir, hostname } from "os";
import { join } from "path";

export const DEVICE_BROKER_DEFAULT_HOST = "127.0.0.1";
export const DEVICE_BROKER_DEFAULT_PORT = 17373;
export const DEVICE_BROKER_NAME = "ccc-device-broker";

export interface DeviceBrokerOptions {
    cwd?: string;
    host?: string;
    port?: number;
    startedAt?: string;
}

function brokerRoot(): string {
    return join(homedir(), ".ccc/devices");
}

function deviceBrokerOwnerId(cwd: string): string {
    return createHash("sha256").update(`${hostname()}:${cwd || "/project"}`).digest("hex").slice(0, 16);
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
    const ownerId = deviceBrokerOwnerId(normalized.cwd);
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
            "owner-state-path-reporting",
            "zero-config-default-port",
        ],
        deferred: [
            "mcp-auto-launch",
            "backend-command-proxy",
            "authentication-token-handshake",
            "physical-device-lease-api",
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

export function createDeviceBrokerServer(options: DeviceBrokerOptions = {}): Server {
    const normalized = normalizeBrokerOptions(options);
    const startedAt = normalized.startedAt;
    return createServer((req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url || "/", `http://${req.headers.host || `${normalized.host}:${normalized.port}`}`);
        if (req.method !== "GET") {
            writeJson(res, 405, { ok: false, error: "method-not-allowed" }, { allow: "GET" });
            return;
        }
        if (url.pathname === "/health") {
            writeJson(res, 200, {
                ok: true,
                name: DEVICE_BROKER_NAME,
                mode: "host-broker-daemon",
                uptimeMs: Date.now() - Date.parse(startedAt),
            });
            return;
        }
        if (url.pathname === "/status") {
            writeJson(res, 200, {
                ok: true,
                broker: deviceBrokerStatus({ ...normalized, startedAt }),
            });
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
