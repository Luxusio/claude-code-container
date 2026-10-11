import { createDeviceAdminDelete, createDeviceAdminPhysicalTransition } from "../../application/device-admin-delete.js";
import type { CleanupBackend, CleanupCommandResult, CleanupRecord } from "../../domain/device-admin-cleanup.js";
import type { DeviceAdminDeletePorts, DeviceAdminPhysicalTransitionPorts, DeviceAdminLeaseScope } from "../../ports/device-admin-delete.js";

function consumedAdminDeleteCapabilities<Backend extends CleanupBackend>(
    ports: DeviceAdminDeletePorts<Backend>,
    transitionPorts: DeviceAdminPhysicalTransitionPorts<Backend>,
    scope: DeviceAdminLeaseScope,
    backend: Backend,
    record: CleanupRecord,
): void {
    const deletion = createDeviceAdminDelete(ports).deleteDevice("owner", backend, "owned-device", record, 5_000);
    const commands: CleanupCommandResult[] = deletion.commands;
    if (!deletion.ok) {
        const refusal: string = deletion.reason;
        void refusal;
    }
    const transitioned: boolean = createDeviceAdminPhysicalTransition(transitionPorts).transitionPhysicalRecord("owner", backend, record, null);
    const { runCommand, ...withoutCommand } = ports;
    // @ts-expect-error Provider resource deletion requires the bounded native command leaf.
    createDeviceAdminDelete(withoutCommand);
    const { withLeaseLock, ...withoutAuthority } = transitionPorts;
    // @ts-expect-error Coupled record publication requires guarded lease authority.
    createDeviceAdminPhysicalTransition(withoutAuthority);
    const { removeLease, ...withoutRemoval } = scope;
    // @ts-expect-error The locked lease scope must support authoritative lease removal.
    createDeviceAdminDelete({ ...ports, withLeaseLock: (_owner, _backend, _record, _hardware, operation) => operation(withoutRemoval) });
    // @ts-expect-error Aggregate compensation must settle inside the native locked scope.
    createDeviceAdminPhysicalTransition({ ...transitionPorts, withLeaseLock: (_owner, _backend, _record, _hardware, operation) => operation({ ...scope, writeAggregate: async () => undefined }) });
    // @ts-expect-error Owner-record CAS must settle before lease compensation is selected.
    createDeviceAdminPhysicalTransition({ ...transitionPorts, transitionRecord: async () => ({ matched: true }) });
    void [commands, transitioned, runCommand, withLeaseLock, removeLease];
}
void consumedAdminDeleteCapabilities;
