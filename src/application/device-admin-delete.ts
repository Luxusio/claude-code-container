import type { CleanupBackend, CleanupRecord } from "../domain/device-admin-cleanup.js";
import { macosManagedProviderResources } from "../domain/device-admin-prune.js";
import { physicalLeaseMatchesOwnerDevice } from "../domain/device-admin-delete.js";
import type { DeviceAdminDeleteResult } from "../domain/device-admin-delete.js";
import type { DeviceAdminDeletePorts, DeviceAdminPhysicalTransitionPorts, DeviceAdminLeaseScope } from "../ports/device-admin-delete.js";

function ownedAggregate(owner: string, device: CleanupRecord, hardwareId: string, scope: DeviceAdminLeaseScope) {
    const previous = scope.readAggregate();
    return { previous, next: previous.filter(candidate => candidate.hardwareId !== hardwareId || !physicalLeaseMatchesOwnerDevice(owner, device, candidate)) };
}

export function createDeviceAdminPhysicalTransition<Backend extends CleanupBackend>(ports: DeviceAdminPhysicalTransitionPorts<Backend>) {
    function transitionPhysicalRecord(owner: string, backend: Backend, expected: CleanupRecord, replacement: CleanupRecord | null): boolean {
        const hardwareId = ports.hardwareId(backend, expected);
        if (!hardwareId) return ports.transitionRecord(owner, backend, expected, replacement).matched;
        return ports.withLeaseLock(owner, backend, expected, hardwareId, scope => {
            const lease = scope.readLease();
            const { previous, next } = ownedAggregate(owner, expected, hardwareId, scope);
            const aggregateChanged = !ports.sameAggregate(previous, next);
            const leaseChanged = physicalLeaseMatchesOwnerDevice(owner, expected, lease);
            if (!aggregateChanged && !leaseChanged) return ports.transitionRecord(owner, backend, expected, replacement).matched;
            if (aggregateChanged) scope.writeAggregate(next);
            if (leaseChanged) {
                try { scope.removeLease(); }
                catch (error) {
                    if (!ports.missingLease(error)) {
                        if (aggregateChanged) {
                            try { scope.writeAggregate(previous); }
                            catch (rollback) { throw new AggregateError([error, rollback], "physical-lease-aggregate-rollback-failed"); }
                        }
                        throw error;
                    }
                }
            }
            let transitionError: unknown;
            let matched = false;
            try { matched = ports.transitionRecord(owner, backend, expected, replacement).matched; }
            catch (error) { transitionError = error; }
            if (matched) return true;
            const errors: unknown[] = [];
            if (leaseChanged) { try { scope.writeLease(lease); } catch (error) { errors.push(error); } }
            if (aggregateChanged) { try { scope.writeAggregate(previous); } catch (error) { errors.push(error); } }
            if (errors.length) throw new AggregateError(transitionError === undefined ? errors : [transitionError, ...errors], "physical-lease-owner-state-rollback-failed");
            if (transitionError !== undefined) throw transitionError;
            return false;
        });
    }
    return { transitionPhysicalRecord };
}

export function createDeviceAdminDelete<Backend extends CleanupBackend, Evidence = unknown>(ports: DeviceAdminDeletePorts<Backend, Evidence>) {
    function releaseLease(owner: string, backend: Backend, device: CleanupRecord): undefined {
        const hardwareId = ports.hardwareId(backend, device);
        if (!hardwareId) return undefined;
        return ports.withLeaseLock(owner, backend, device, hardwareId, scope => {
            const lease = scope.readLease();
            if (!physicalLeaseMatchesOwnerDevice(owner, device, lease)) return undefined;
            const { previous, next } = ownedAggregate(owner, device, hardwareId, scope);
            const changed = !ports.sameAggregate(previous, next);
            if (changed) scope.writeAggregate(next);
            try { scope.removeLease(); }
            catch (error) {
                if (ports.missingLease(error)) return undefined;
                if (changed) {
                    try { scope.writeAggregate(previous); }
                    catch (rollback) { throw new AggregateError([error, rollback], "physical-lease-aggregate-rollback-failed"); }
                }
                throw error;
            }
            return undefined;
        });
    }
    function deleteDevice(owner: string, backend: Backend, deviceId: string, expected: CleanupRecord, timeoutMs?: number): DeviceAdminDeleteResult<Evidence> {
        return ports.withRecordLock(owner, backend.stateKey, deviceId, () => {
            const current = ports.readDevices(owner, backend.stateKey).find(candidate => candidate.id === deviceId);
            if (!current || !ports.sameRecord(current, expected)) return { ok: false, reason: "owner-device-state-conflict", evidence: [] };
            if (current.status !== "stopped" && current.status !== "detached") return { ok: false, reason: `device-status-${current.status || "unknown"}`, evidence: [] };
            const evidence: Evidence[] = [];
            let failed = false;
            if (backend.stateKey === "macos") for (const resource of macosManagedProviderResources(current)) {
                const result = ports.deleteManagedResource(resource.provider, resource.instance, timeoutMs);
                if (result.state !== "no-result") {
                    evidence.push(result.evidence);
                    if (result.state === "failure") failed = true;
                }
            }
            if (failed) return { ok: false, reason: "provider-delete-failed", evidence };
            try { releaseLease(owner, backend, current); }
            catch { return { ok: false, reason: "physical-lease-release-failed", evidence }; }
            ports.releaseWindowsClaim(owner, backend, current);
            if (!ports.transitionRecord(owner, backend, current, null).matched) return { ok: false, reason: "owner-device-state-conflict", evidence };
            return { ok: true, evidence };
        });
    }
    return { deleteDevice };
}
