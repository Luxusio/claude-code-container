// src/localhost-proxy.ts - Transparent localhost proxy for macOS/Windows Docker
//
// On macOS/Windows, --network host doesn't truly share the host network.
// This proxy intercepts localhost traffic (via iptables REDIRECT) and:
//   1. Tries connecting to localhost:PORT (container server)
//   2. If ECONNREFUSED, falls back to host.docker.internal:PORT (host server)
//
// On Linux, this is unnecessary because --network host works natively.

import * as net from "net";
import { createLocalhostProxy } from "./application/localhost-proxy.js";

export const PROXY_PORT = 19999;
const CONNECT_TIMEOUT = 3000;

/**
 * Try to connect to host:port. Resolves with the socket or rejects on error.
 */
export function tryConnect(host: string, port: number): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection({ host, port });
        const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error(`Connection timeout to ${host}:${port}`));
        }, CONNECT_TIMEOUT);

        socket.on("connect", () => {
            clearTimeout(timer);
            resolve(socket);
        });
        socket.on("error", (err) => {
            clearTimeout(timer);
            socket.destroy();
            reject(err);
        });
    });
}

/**
 * Handle a proxied connection: try local first, then fallback to host.
 * @param client - The incoming client socket (redirected by iptables)
 * @param originalPort - The original destination port
 * @param localAddr - Local address to try first (default: 127.0.0.1)
 * @param hostAddr - Fallback host address (default: host.docker.internal)
 * @param hostPort - Fallback port (default: same as originalPort)
 */
export const proxyConnection = createLocalhostProxy<Buffer, net.Socket>({
    connect: (host, port) => tryConnect(host, port),
}).proxyConnection;

/**
 * Start the transparent proxy server.
 * In production, SO_ORIGINAL_DST is used to get the original port.
 * For testing, proxyConnection is called directly with known ports.
 */
export function startProxy(port: number = PROXY_PORT): Promise<net.Server> {
    return new Promise((resolve) => {
        const server = net.createServer((client) => {
            // Read original destination via SO_ORIGINAL_DST
            // Level: SOL_IP (0), Optname: SO_ORIGINAL_DST (80)
            try {
                const buf = (client as any)._handle?.getsockopt?.(0, 80);
                if (buf && buf.length >= 8) {
                    // Parse sockaddr_in: family(2) + port(2) + addr(4)
                    const originalPort = buf.readUInt16BE(2);
                    proxyConnection(client, originalPort);
                } else {
                    // SO_ORIGINAL_DST not available (no iptables redirect)
                    client.destroy();
                }
            } catch {
                client.destroy();
            }
        });

        server.on("error", () => { /* ignore server errors */ });
        server.listen(port, "127.0.0.1", () => resolve(server));
    });
}

/**
 * Stop the proxy server.
 */
export function stopProxy(server: net.Server): void {
    server.close();
}
