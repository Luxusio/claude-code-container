export const DEFAULT_PHYSICAL_LEASE_TTL_MS = 60 * 60 * 1000;
export function physicalLeaseHeartbeatKey(ownerId: string, backend: string, hardwareId: string, deviceId?: string) {
    return `${ownerId}\0${backend}\0${hardwareId}\0${deviceId || ""}`;
}
export function physicalLeaseHeartbeatIntervalMs(ttlMs: number) {
    return Math.max(10 * 1000, Math.min(5 * 60 * 1000, Math.floor(ttlMs / 3)));
}
const MIN_PHYSICAL_LEASE_TTL_MS = 30 * 1000;
const MAX_PHYSICAL_LEASE_TTL_MS = 24 * 60 * 60 * 1000;
export const PHYSICAL_LEASE_BACKENDS: readonly string[] = ["android-device", "ios-device"];
/** Guarded native reads retain mutable legacy and transport fields. */
export type PhysicalLeaseRecord = Record<string, unknown>;
export type LeaseFailure =
    {kind:'invalid'; error:string; allowed?:string[]} |
    {kind:'forbidden'; error:string; conflict?:PhysicalLeaseRecord} |
    {kind:'conflict'; error:string; conflict?:PhysicalLeaseRecord; lease?:PhysicalLeaseRecord} |
    {kind:'missing'; error:string} |
    {kind:'expired'; error:string; lease:PhysicalLeaseRecord; pruned:boolean} |
    {kind:'directory-refused'; error:string; backend?:string; detail?:unknown} |
    {kind:'scan-limit'; error:string; backend?:string; limit?:number};
export type ClaimOutcome = {kind:'claimed'; lease:PhysicalLeaseRecord; created:boolean; reused?:boolean; heartbeat?:boolean} | LeaseFailure;
export type HeartbeatOutcome = {kind:'renewed'; lease:PhysicalLeaseRecord} | LeaseFailure;
export type ReleaseOutcome = {kind:'released'; lease:PhysicalLeaseRecord} | LeaseFailure;
export type PruneOutcome = {kind:'pruned'; ownerId:string; backend:string; leases:PhysicalLeaseRecord[]} | LeaseFailure;
export interface LeaseWaitBudget { remaining(): number }
export type LeaseDirectoryInspection = {ok:true; exists:boolean} | {ok:false; failure:LeaseFailure};
export type LeaseDirectoryScan = {ok:true; entries:Array<{file:string;hardwareId:string}>} | {ok:false; failure:LeaseFailure};
export type LeaseParamError = {ok:false; kind:'invalid'|'forbidden'; error:string; allowed?:string[]};
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
        return { ok: false, kind: "invalid", error: "invalid-lease-params" };
    }
    const input = params as Record<string, unknown>;
    const backend = typeof input.backend === "string" ? input.backend : "";
    if (!PHYSICAL_LEASE_BACKENDS.includes(backend)) {
        return { ok: false, kind: "invalid", error: "invalid-lease-backend", allowed: [...PHYSICAL_LEASE_BACKENDS] };
    }
    if (input.all === true) {
        return { ok: false, kind: "forbidden", error: "all-owner-lease-list-requires-admin" };
    }
    const hardwareId = typeof input.hardwareId === "string" ? input.hardwareId.trim() : "";
    if (action !== "list" && action !== "prune" && (!hardwareId || hardwareId.length > 256 || /[\u0000-\u001f]/.test(hardwareId))) {
        return { ok: false, kind: "invalid", error: "invalid-hardware-id" };
    }
    const deviceId = typeof input.deviceId === "string" ? input.deviceId.trim() : null;
    if (deviceId !== null && (!deviceId || deviceId.length > 128 || /[^a-zA-Z0-9._:-]/.test(deviceId))) {
        return { ok: false, kind: "invalid", error: "invalid-device-id" };
    }
    const connection = typeof input.connection === "string" ? input.connection : "unknown";
    if (!["usb", "wifi", "unknown"].includes(connection)) {
        return { ok: false, kind: "invalid", error: "invalid-connection" };
    }
    const transport = input.transport && typeof input.transport === "object" && !Array.isArray(input.transport)
        ? input.transport
        : {};
    const ttlMs = normalizedLeaseTtlMs(input.ttlMs);
    if (ttlMs === null) {
        return { ok: false, kind: "invalid", error: "invalid-lease-ttl-ms" };
    }
    const claimId = typeof input.claimId === "string" ? input.claimId.trim() : null;
    const claimNonce = typeof input.claimNonce === "string" ? input.claimNonce.trim() : null;
    if (claimId !== null && (!claimId || claimId.length > 128 || /[^a-zA-Z0-9._:-]/.test(claimId))) {
        return { ok: false, kind: "invalid", error: "invalid-lease-claim-id" };
    }
    if (claimNonce !== null && (!claimNonce || claimNonce.length > 128 || /[^a-zA-Z0-9._:-]/.test(claimNonce))) {
        return { ok: false, kind: "invalid", error: "invalid-lease-claim-nonce" };
    }
    return { ok: true, backend, hardwareId, deviceId, connection, transport, ttlMs, claimId, claimNonce };
}

export function leaseParamError(parsed: LeaseParamError): LeaseFailure {
    return {kind:parsed.kind,error:parsed.error,...(parsed.allowed ? {allowed:parsed.allowed} : {})};
}
