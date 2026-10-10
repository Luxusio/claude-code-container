import { DEFAULT_PHYSICAL_LEASE_TTL_MS, validateLeaseParams, leaseParamError, type LeaseParamSuccess, type LeaseRpcResult, type LeaseWaitBudget } from "../domain/broker-physical-leases.js";
import type { BrokerPhysicalLeasePorts } from "../ports/broker-physical-leases.js";
import { createLeaseDatePolicy } from "./broker-observation-leases.js";

export function createBrokerPhysicalLeasesApplication(ports: BrokerPhysicalLeasePorts) {
    const dates = createLeaseDatePolicy(ports, DEFAULT_PHYSICAL_LEASE_TTL_MS);
    const leaseTtlMs = dates.ttlMs;
    const leaseExpiresAt = dates.expiresAt;
    function leaseExpired(lease: Record<string, unknown>) { return dates.expired(lease, ports.nowMs()); }
    function withLeaseExpiry(lease: Record<string, unknown>, ttlMs = leaseTtlMs(lease), now = ports.timestamp()) {
        return { ...lease, ttlMs, heartbeatAt: now, updatedAt: now, expiresAt: ports.expiryFrom(now, ttlMs) };
    }
    function pruneExpired(file: string) { try { ports.remove(file); return true; } catch { return false; } }
function createPhysicalLease(ownerId: string, parsed: LeaseParamSuccess, now: string) {
    return withLeaseExpiry({
        backend: parsed.backend,
        hardwareId: parsed.hardwareId,
        ownerId,
        deviceId: parsed.deviceId,
        connection: parsed.connection,
        transport: parsed.transport,
        claimId: ports.newClaimId(),
        ...(parsed.claimNonce ? { claimNonce: parsed.claimNonce } : {}),
        claimedAt: now,
    }, parsed.ttlMs, now);
}

function claimPhysicalLease(ownerId: string, params: unknown): LeaseRpcResult {
    const parsed = validateLeaseParams(params, "claim");
    if (!parsed.ok) return leaseParamError(parsed);
    const directory = ports.prepareDirectory(parsed.backend);
    if (!directory.ok) return { status: directory.status, payload: directory.payload };
    const file = ports.leaseFile(parsed.backend, parsed.hardwareId);
    return ports.withHardwareLock(parsed.backend, parsed.hardwareId, () => {
        const now = ports.timestamp();
        const existing = ports.read(file, parsed.backend, parsed.hardwareId);
        if (existing && !leaseExpired(existing) && existing.ownerId === ownerId) {
            if (parsed.deviceId && existing.deviceId && existing.deviceId !== parsed.deviceId) {
                return { status: 409, payload: { ok: false, error: "physical-lease-device-mismatch", conflict: existing } };
            }
            if (parsed.claimNonce && existing.claimNonce !== parsed.claimNonce) {
                return { status: 409, payload: { ok: false, error: "physical-lease-operation-conflict", conflict: existing } };
            }
            const refreshed = withLeaseExpiry(existing, parsed.ttlMs, now);
            ports.write(file, refreshed);
            return { status: 200, payload: { ok: true, result: { lease: refreshed, created: false, reused: true, heartbeat: true } } };
        }
        if (existing && !leaseExpired(existing)) {
            return {
                status: 409,
                payload: {
                    ok: false,
                    error: "physical-lease-conflict",
                    conflict: existing,
                },
            };
        }
        const lease = createPhysicalLease(ownerId, parsed, now);
        ports.write(file, lease);
        return { status: 200, payload: { ok: true, result: { lease, created: true } } };
    });
}

function heartbeatPhysicalBrokerLease(ownerId: string, params: unknown, waitBudget?: LeaseWaitBudget) {
    const parsed = validateLeaseParams(params, "heartbeat");
    if (!parsed.ok) return leaseParamError(parsed);
    const directory = ports.inspectDirectory(parsed.backend);
    if (!directory.ok) return { status: directory.status, payload: directory.payload };
    if (!directory.exists) return { status: 404, payload: { ok: false, error: "physical-lease-not-found" } };
    const file = ports.leaseFile(parsed.backend, parsed.hardwareId);
    return ports.withHardwareLock(parsed.backend, parsed.hardwareId, () => {
        const existing = ports.read(file, parsed.backend, parsed.hardwareId);
        if (!existing) return { status: 404, payload: { ok: false, error: "physical-lease-not-found" } };
        if (existing.ownerId !== ownerId) {
            if (leaseExpired(existing)) {
                const pruned = pruneExpired(file);
                return { status: 404, payload: { ok: false, error: "physical-lease-expired", pruned, lease: existing } };
            }
            return { status: 403, payload: { ok: false, error: "physical-lease-owned-by-another-owner", conflict: existing } };
        }
        if (parsed.deviceId && existing.deviceId && existing.deviceId !== parsed.deviceId) {
            return { status: 409, payload: { ok: false, error: "physical-lease-device-mismatch", lease: existing } };
        }
        if (parsed.claimId && existing.claimId !== parsed.claimId) {
            return { status: 409, payload: { ok: false, error: "physical-lease-claim-mismatch", lease: existing } };
        }
        if (parsed.claimNonce && existing.claimNonce !== parsed.claimNonce) {
            return { status: 409, payload: { ok: false, error: "physical-lease-operation-mismatch", lease: existing } };
        }
        if (leaseExpired(existing)) {
            const pruned = pruneExpired(file);
            return { status: 404, payload: { ok: false, error: "physical-lease-expired", pruned, lease: existing } };
        }
        const refreshed = withLeaseExpiry(existing, parsed.ttlMs);
        ports.write(file, refreshed);
        return { status: 200, payload: { ok: true, result: { lease: refreshed, heartbeat: true } } };
    }, waitBudget);
}

function physicalLeaseReleaseConflict(ownerId: string, parsed: LeaseParamSuccess, existing: Record<string, unknown> | null): LeaseRpcResult | null {
    if (!existing) return { status: 404, payload: { ok: false, error: "physical-lease-not-found" } };
    if (existing.ownerId !== ownerId) {
        return { status: 403, payload: { ok: false, error: "physical-lease-owned-by-another-owner", conflict: existing } };
    }
    if (parsed.deviceId && existing.deviceId && existing.deviceId !== parsed.deviceId) {
        return { status: 409, payload: { ok: false, error: "physical-lease-device-mismatch", lease: existing } };
    }
    if (parsed.claimId && existing.claimId !== parsed.claimId) {
        return { status: 409, payload: { ok: false, error: "physical-lease-claim-mismatch", lease: existing } };
    }
    if (parsed.claimNonce && existing.claimNonce !== parsed.claimNonce) {
        return { status: 409, payload: { ok: false, error: "physical-lease-operation-mismatch", lease: existing } };
    }
    return null;
}

function completePhysicalBrokerLeaseRelease(ownerId: string, parsed: LeaseParamSuccess, file: string, existing: Record<string, unknown>): LeaseRpcResult {
    ports.remove(file);
    ports.stopHeartbeat(ownerId, parsed.backend, parsed.hardwareId, parsed.deviceId || undefined);
    return { status: 200, payload: { ok: true, result: { released: true, lease: existing } } };
}

function restorePhysicalBrokerLeaseRelease(ownerId: string, parsed: LeaseParamSuccess, file: string, existing: Record<string, unknown>) {
    if (ports.fileExists(file)) {
        return { attempted: true, ok: false, error: "physical-lease-rollback-path-occupied", lease: ports.read(file, parsed.backend, parsed.hardwareId) };
    }
    try {
        const restored: Record<string, unknown> = withLeaseExpiry(existing);
        ports.write(file, restored);
        const deviceId = typeof restored.deviceId === "string" ? restored.deviceId : parsed.deviceId;
        const heartbeat = deviceId
            ? ports.startHeartbeat(ownerId, parsed.backend, parsed.hardwareId, deviceId, {
                ttlMs: leaseTtlMs(restored),
                claimId: typeof restored.claimId === "string" ? restored.claimId : undefined,
                claimNonce: typeof restored.claimNonce === "string" ? restored.claimNonce : undefined,
            })
            : null;
        return { attempted: true, ok: true, lease: restored, heartbeat };
    } catch (error) {
        return {
            attempted: true,
            ok: false,
            error: "physical-lease-rollback-write-failed",
            detail: error instanceof Error ? error.message : String(error),
        };
    }
}

function releasePhysicalBrokerLease(ownerId: string, params: unknown) {
    const parsed = validateLeaseParams(params, "release");
    if (!parsed.ok) return leaseParamError(parsed);
    const directory = ports.inspectDirectory(parsed.backend);
    if (!directory.ok) return { status: directory.status, payload: directory.payload };
    if (!directory.exists) return { status: 404, payload: { ok: false, error: "physical-lease-not-found" } };
    const file = ports.leaseFile(parsed.backend, parsed.hardwareId);
    return ports.withHardwareLock(parsed.backend, parsed.hardwareId, () => {
        const existing = ports.read(file, parsed.backend, parsed.hardwareId);
        const conflict = physicalLeaseReleaseConflict(ownerId, parsed, existing);
        if (conflict) return conflict;
        return completePhysicalBrokerLeaseRelease(ownerId, parsed, file, existing!);
    });
}

function prunePhysicalBrokerLeases(ownerId: string, params: unknown) {
    const parsed = validateLeaseParams(params, "prune");
    if (!parsed.ok) return leaseParamError(parsed);
    const pruned: Array<Record<string, unknown>> = [];
    const scan = ports.scan(parsed.backend);
    if (!scan.ok) return { status: scan.status, payload: scan.payload };
    for (const { file, hardwareId } of scan.entries) {
        ports.withHardwareLock(parsed.backend, hardwareId, () => {
            const lease = ports.read(file, parsed.backend, hardwareId);
            if (!lease || lease.ownerId !== ownerId || !leaseExpired(lease)) return;
            try {
                ports.remove(file);
                pruned.push({ ...lease, expired: true, expiresAt: leaseExpiresAt(lease) });
            } catch {
                // A later prune can retry.
            }
        });
    }
    return { status: 200, payload: { ok: true, result: { ownerId, backend: parsed.backend, pruned } } };
}

    return {claim: claimPhysicalLease, heartbeat: heartbeatPhysicalBrokerLease, release: releasePhysicalBrokerLease,
        prune: prunePhysicalBrokerLeases, releaseConflict: physicalLeaseReleaseConflict, completeRelease: completePhysicalBrokerLeaseRelease,
        restoreReleased: restorePhysicalBrokerLeaseRelease, withExpiry: withLeaseExpiry};
}
