// src/localhost-proxy-setup.ts - Sets up iptables + proxy daemon in container
//
// On macOS/Windows Docker, --network host doesn't truly share the host network.
// This module sets up:
//   1. iptables REDIRECT rule: all localhost TCP → proxy port (excluding ccc-proxy user)
//   2. proxy daemon running as ccc-proxy user inside the container
//
// On Linux, this is skipped entirely (--network host works natively).

import { spawnSync } from "child_process";
import { PROXY_PORT } from "./localhost-proxy.js";
import { runtimeCli, isContainerHostRemote } from "./container-runtime.js";

// UID for ccc-proxy user (created in Dockerfile with useradd -r)
// We detect it at runtime via `id -u ccc-proxy` inside the container.

/**
 * Check if localhost proxy is already running in the container.
 */
function isProxyRunning(containerName: string): boolean {
    const result = spawnSync(
        runtimeCli(),
        ["exec", containerName, "sh", "-c", `ss -tlnp 2>/dev/null | grep -q ':${PROXY_PORT}'`],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    return result.status === 0;
}

/**
 * Set up iptables rule and start proxy daemon in the container.
 * Only runs on macOS/Windows (where --network host doesn't work).
 * Errors are logged but never block container exec.
 */
export function setupLocalhostProxy(containerName: string): void {
    // Skip on native Linux — --network host works natively.
    // On VM-backed runtimes (Docker Desktop, podman machine, WSL2), --network host
    // actually shares the VM's network, not the host's — the proxy forwards
    // localhost traffic to host.docker.internal.
    if (process.platform === "linux" && !isContainerHostRemote()) {
        return;
    }

    // Skip if proxy is already running (container reuse)
    if (isProxyRunning(containerName)) {
        return;
    }

    const cli = runtimeCli();

    try {
        // Get ccc-proxy UID
        const uidResult = spawnSync(
            cli,
            ["exec", containerName, "id", "-u", "ccc-proxy"],
            { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
        );
        const proxyUid = (uidResult.stdout ?? "").trim();
        if (!proxyUid || uidResult.status !== 0) {
            if (process.env.DEBUG) {
                console.error("[ccc] ccc-proxy user not found in container, skipping proxy setup");
            }
            return;
        }

        // Set up iptables REDIRECT rule
        // All TCP traffic to 127.0.0.1 (any port) is redirected to PROXY_PORT,
        // EXCEPT traffic from ccc-proxy user (to avoid infinite loop).
        // -C checks if the rule already exists; if not, -A adds it.
        const checkResult = spawnSync(
            cli,
            [
                "exec", containerName,
                "sudo", "iptables", "-t", "nat", "-C", "OUTPUT",
                "-p", "tcp", "-d", "127.0.0.1",
                "-m", "owner", "!", "--uid-owner", proxyUid,
                "-j", "REDIRECT", "--to-ports", String(PROXY_PORT),
            ],
            { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
        );

        if (checkResult.status !== 0) {
            // Rule doesn't exist, add it
            const addResult = spawnSync(
                cli,
                [
                    "exec", containerName,
                    "sudo", "iptables", "-t", "nat", "-A", "OUTPUT",
                    "-p", "tcp", "-d", "127.0.0.1",
                    "-m", "owner", "!", "--uid-owner", proxyUid,
                    "-j", "REDIRECT", "--to-ports", String(PROXY_PORT),
                ],
                { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
            );

            if (addResult.status !== 0) {
                if (process.env.DEBUG) {
                    console.error(`[ccc] iptables setup failed: ${addResult.stderr}`);
                }
                return;
            }
        }

        // Start proxy daemon as ccc-proxy user in background
        // Uses the pre-compiled Go binary (no runtime dependencies)
        spawnSync(
            cli,
            [
                "exec", "-d",
                "-u", proxyUid,
                containerName,
                "/usr/local/bin/ccc-proxy",
            ],
            { stdio: ["pipe", "pipe", "pipe"] },
        );

        if (process.env.DEBUG) {
            console.error(`[ccc] localhost proxy started on port ${PROXY_PORT}`);
        }
    } catch (err) {
        if (process.env.DEBUG) {
            console.error(`[ccc] localhost proxy setup failed: ${err}`);
        }
        // Never block container exec
    }
}
