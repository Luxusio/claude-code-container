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
import { createLocalhostProxyVerifier } from "./application/localhost-proxy-setup.js";
import { PROXY_PORT } from "./localhost-proxy.js";
import { runtimeCli, isContainerHostRemote } from "./container-runtime.js";
import { detectHostNetworkReach } from "./network-reach.js";

const STEP_TIMEOUT_MS = 5_000;

function observeProxyListener(containerName: string) {
    // Inspect the kernel socket table without ss or a TCP connection: probing
    // the transparent proxy's own port can make it forward back into itself.
    const address = `0100007F:${PROXY_PORT.toString(16).toUpperCase().padStart(4, "0")}`;
    const script =
        `while read -r slot local_address remote_address state rest; do ` +
        `if [[ "$local_address" == "${address}" && "$state" == "0A" ]]; then exit 0; fi; ` +
        `done < /proc/net/tcp; exit 1`;
    const result = spawnSync(
        runtimeCli(),
        ["exec", containerName, "bash", "-c", script],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: STEP_TIMEOUT_MS },
    );
    return result;
}

export function setupLocalhostProxy(containerName: string): void {
    createLocalhostProxyVerifier({
        platform: () => process.platform,
        containerHostRemote: () => isContainerHostRemote(),
        directReach: (container, timeoutMs) => detectHostNetworkReach(container, {timeoutMs}),
        proxyListenerObservation: container => observeProxyListener(container),
        debugFlag: () => process.env.DEBUG,
        runtimeName: () => runtimeCli(),
        get reportDebug() {
            const report = console.error;
            return (message: string): undefined => { report.call(console, message); return undefined; };
        },
        get reportWarning() {
            const report = console.warn;
            return (message: string): undefined => { report.call(console, message); return undefined; };
        },
    }).setup(containerName);
}
