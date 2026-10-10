export const DEFAULT_PHYSICAL_LEASE_TTL_MS = 60 * 60 * 1000;
const MIN_PHYSICAL_LEASE_TTL_MS = 30 * 1000;
const MAX_PHYSICAL_LEASE_TTL_MS = 24 * 60 * 60 * 1000;
export const PHYSICAL_LEASE_BACKENDS: readonly string[] = ["android-device", "ios-device"];
/** Guarded native reads retain mutable legacy and transport fields. */
export type PhysicalLeaseRecord = Record<string, unknown>;
export interface LeaseRpcResult { status: number; payload: unknown }
export interface LeaseWaitBudget { remaining(): number }
export type LeaseDirectoryInspection = {ok: true; exists: boolean} | {ok: false; status: number; payload: Record<string, unknown>};
export type LeaseDirectoryScan = {ok: true; entries: Array<{file: string; hardwareId: string}>} | {ok: false; status: number; payload: Record<string, unknown>};
export type LeaseParamError = { ok: false; status: number; error: string; allowed?: string[] };
export type LeaseParamSuccess = {
    ok: true;
    backend: string;
    hardwareId: string;
    deviceId: string | null;
    connection: string;
    transport: object;
    ttlMs: number;
    claimId: string | null;
    claimNonce: string | null;
};
export function normalizedLeaseTtlMs(value: unknown) {
    if (value === undefined || value === null) return DEFAULT_PHYSICAL_LEASE_TTL_MS;
    if (typeof value !== "number" || !Number.isInteger(value) || value < MIN_PHYSICAL_LEASE_TTL_MS || value > MAX_PHYSICAL_LEASE_TTL_MS) {
        return null;
    }
    return value;
}

export function validateLeaseParams(params: unknown, action: "claim" | "list" | "release" | "heartbeat" | "prune"): LeaseParamError | LeaseParamSuccess {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
        return { ok: false, status: 400, error: "invalid-lease-params" };
    }
    const input = params as Record<string, unknown>;
    const backend = typeof input.backend === "string" ? input.backend : "";
    if (!PHYSICAL_LEASE_BACKENDS.includes(backend)) {
        return { ok: false, status: 400, error: "invalid-lease-backend", allowed: [...PHYSICAL_LEASE_BACKENDS] };
    }
    if (input.all === true) {
        return { ok: false, status: 403, error: "all-owner-lease-list-requires-admin" };
    }
    const hardwareId = typeof input.hardwareId === "string" ? input.hardwareId.trim() : "";
    if (action !== "list" && action !== "prune" && (!hardwareId || hardwareId.length > 256 || /[\u0000-\u001f]/.test(hardwareId))) {
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
    const ttlMs = normalizedLeaseTtlMs(input.ttlMs);
    if (ttlMs === null) {
        return { ok: false, status: 400, error: "invalid-lease-ttl-ms" };
    }
    const claimId = typeof input.claimId === "string" ? input.claimId.trim() : null;
    const claimNonce = typeof input.claimNonce === "string" ? input.claimNonce.trim() : null;
    if (claimId !== null && (!claimId || claimId.length > 128 || /[^a-zA-Z0-9._:-]/.test(claimId))) {
        return { ok: false, status: 400, error: "invalid-lease-claim-id" };
    }
    if (claimNonce !== null && (!claimNonce || claimNonce.length > 128 || /[^a-zA-Z0-9._:-]/.test(claimNonce))) {
        return { ok: false, status: 400, error: "invalid-lease-claim-nonce" };
    }
    return { ok: true, backend, hardwareId, deviceId, connection, transport, ttlMs, claimId, claimNonce };
}

export function leaseParamError(parsed: LeaseParamError) {
    return {
        status: parsed.status,
        payload: {
            ok: false,
            error: parsed.error,
            ...(parsed.allowed ? { allowed: parsed.allowed } : {}),
        },
    };
}
