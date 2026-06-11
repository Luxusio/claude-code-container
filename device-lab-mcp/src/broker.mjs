import { homedir } from "os";
import { join } from "path";
import { ownerId } from "./context.mjs";

const HOST_CANDIDATES = [
    "host.docker.internal",
    "host.containers.internal",
    "gateway.docker.internal",
    "172.17.0.1",
    "10.0.2.2",
];
const MAX_PROBE_CANDIDATES = 8;
const MAX_PROBE_TIMEOUT_MS = 2000;

export function brokerStateRoot() {
    return join(homedir(), ".ccc/devices");
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

async function probeBrokerHealth({ hostCandidates, port, timeoutMs }) {
    const attempts = [];
    for (const host of hostCandidates) {
        const endpoint = `http://${host}:${port}/health`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const startedAt = Date.now();
        try {
            const response = await fetch(endpoint, { signal: controller.signal });
            const text = await response.text();
            let body = null;
            try {
                body = text ? JSON.parse(text) : null;
            } catch {
                body = { raw: text };
            }
            const attempt = {
                host,
                port,
                endpoint,
                ok: response.ok,
                status: response.status,
                durationMs: Date.now() - startedAt,
                body,
            };
            attempts.push(attempt);
            if (response.ok) return { requested: true, available: true, selected: attempt, attempts };
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

export async function brokerStatus(options = {}) {
    const owner = ownerId();
    const root = brokerStateRoot();
    const probeOptions = normalizeProbeOptions(options);
    const probe = probeOptions.probe
        ? await probeBrokerHealth(probeOptions)
        : { requested: false, available: false, selected: null, attempts: [] };
    return {
        ownerId: owner,
        mode: probe.available ? "host-broker-detected" : "direct-provider",
        lazy: true,
        available: probe.available,
        startupPolicy: "no daemon is started by status, inventory, or backend discovery calls",
        transport: {
            preferred: "http",
            hostCandidates: probeOptions.hostCandidates,
            defaultPort: probeOptions.port,
            zeroConfig: true,
            environmentRequired: false,
            probeTimeoutMs: probeOptions.timeoutMs,
            maxProbeCandidates: MAX_PROBE_CANDIDATES,
            maxProbeTimeoutMs: MAX_PROBE_TIMEOUT_MS,
        },
        probe,
        state: {
            root,
            ownerRoot: join(root, "owners", owner),
            locksRoot: join(root, "broker", "locks"),
            logsRoot: join(root, "broker", "logs"),
        },
        implemented: [
            "owner-scoped direct provider adapters",
            "owner-scoped state layout",
            "physical device lease files",
            "explicit all-owner admin cleanup commands",
            "broker contract inspection",
            "broker health probe",
        ],
        deferred: [
            "host broker daemon launcher",
            "broker HTTP transport",
            "broker-managed backend command execution",
            "broker authentication token handshake",
        ],
        note: "Device backends currently run in direct-provider mode. The broker contract is exposed so agents can detect the current host-control mode before requesting lifecycle work.",
    };
}
