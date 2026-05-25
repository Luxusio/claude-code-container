// src/localhost-proxy-setup.ts — host-side verification for the in-container
// proxy setup.
//
// The actual iptables/daemon configuration lives in scripts/ccc-entrypoint.sh
// and runs exactly once at container start. The host-side code here is just
// the verification layer:
//   1. Skip entirely on native-Linux Docker (--network host already shares
//      the host loopback — no proxy needed).
//   2. Probe whether the container can already reach host loopback directly
//      (WSL2 mirrored networking mode, etc.) — when it can, the entrypoint
//      didn't bother running, so skip verification.
//   3. Otherwise: confirm the proxy daemon the entrypoint started is alive.
//      If it isn't, surface a single actionable warning pointing at the
//      docker logs.

import { spawnSync } from "child_process";
import { PROXY_PORT } from "./localhost-proxy.js";
import { runtimeCli, isContainerHostRemote } from "./container-runtime.js";
import { detectHostNetworkReach } from "./network-reach.js";

const STEP_TIMEOUT_MS = 5_000;

function isProxyRunning(containerName: string): boolean {
    const result = spawnSync(
        runtimeCli(),
        ["exec", containerName, "sh", "-c", `ss -tlnp 2>/dev/null | grep -q ':${PROXY_PORT}'`],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: STEP_TIMEOUT_MS },
    );
    return result.status === 0;
}

export function setupLocalhostProxy(containerName: string): void {
    if (process.platform === "linux" && !isContainerHostRemote()) {
        return;
    }

    const reach = detectHostNetworkReach(containerName, { timeoutMs: 1500 });
    if (reach.reachable) {
        if (process.env.DEBUG) {
            console.error(
                `[ccc] host loopback reachable from container (${reach.latencyMs}ms) — proxy not needed`,
            );
        }
        return;
    }

    if (!isProxyRunning(containerName)) {
        console.warn(
            `[ccc] WARNING: localhost proxy daemon not detected — host port access may fail.`,
        );
        console.warn(
            `[ccc]   check \`${runtimeCli()} logs ${containerName}\` for entrypoint errors.`,
        );
    }
}
