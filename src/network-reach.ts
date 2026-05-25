// src/network-reach.ts — detect whether the container has direct host reach
// (WSL2 mirrored mode, real --network host on Linux, etc.). When it does,
// the iptables/proxy setup is unnecessary and can be skipped entirely.
//
// The probe runs inside the container via `docker exec` and tries TCP
// connect to a known always-on host port (default: host.docker.internal:53,
// the embedded DNS responder on Docker Desktop / WSL2). The single shell
// script encapsulates the nc → bash /dev/tcp fallback so we get one clean
// exit code regardless of which tool the container has.
//
// Exit-code contract from the embedded script:
//   0     — TCP connect succeeded
//   1..   — connect attempted but failed (refused / unreachable)
//   127   — no probe binary available
//   null  — spawnSync timed out (status=null, may have signal=SIGTERM)

import { spawnSync as realSpawnSync } from "child_process";
import { runtimeCli as realRuntimeCli } from "./container-runtime.js";

export type ReachReason = "unreachable" | "timeout" | "no-probe";

export interface ReachResult {
    reachable: boolean;
    latencyMs: number;
    reason?: ReachReason;
}

export interface ReachOptions {
    spawnImpl?: typeof realSpawnSync;
    runtimeCli?: () => string;
    timeoutMs?: number;
    probeHost?: string;
    probePort?: number;
    nowImpl?: () => number;
}

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_PROBE_HOST = "host.docker.internal";
const DEFAULT_PROBE_PORT = 53;

export function detectHostNetworkReach(containerName: string, opts: ReachOptions = {}): ReachResult {
    const spawnImpl = opts.spawnImpl ?? realSpawnSync;
    const runtimeCli = opts.runtimeCli ?? realRuntimeCli;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const probeHost = opts.probeHost ?? DEFAULT_PROBE_HOST;
    const probePort = opts.probePort ?? DEFAULT_PROBE_PORT;
    const nowImpl = opts.nowImpl ?? Date.now;

    const ncTimeoutSec = Math.max(1, Math.ceil(timeoutMs / 1000));
    // Single self-contained probe — exit code is the entire signal.
    // The `exec 3<>...` form opens a TCP socket via bash's /dev/tcp facility;
    // it closes immediately after, which is fine — we only care about whether
    // the handshake completed.
    const script =
        `if command -v nc >/dev/null 2>&1; then ` +
        `nc -z -w ${ncTimeoutSec} ${probeHost} ${probePort}; ` +
        `elif command -v bash >/dev/null 2>&1; then ` +
        `bash -c 'exec 3<>/dev/tcp/${probeHost}/${probePort}' 2>/dev/null; ` +
        `else exit 127; fi`;

    const start = nowImpl();
    const result = spawnImpl(
        runtimeCli(),
        ["exec", containerName, "sh", "-c", script],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: timeoutMs },
    );
    const latencyMs = nowImpl() - start;

    if (result.status === 0) {
        return { reachable: true, latencyMs };
    }

    if (result.status === null) {
        return { reachable: false, latencyMs, reason: "timeout" };
    }

    if (result.status === 127) {
        return { reachable: false, latencyMs, reason: "no-probe" };
    }

    return { reachable: false, latencyMs, reason: "unreachable" };
}
