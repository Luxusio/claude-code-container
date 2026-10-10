import { deviceAdminPruneEligible, deviceAdminPrunedLine, type DeviceAdminPruneBackend, type DeviceAdminPruneRecord } from "../domain/device-admin-prune.js";
import type { DeviceAdminPrunePorts } from "../ports/device-admin-prune.js";

export function createDeviceAdminPrune<Backend extends DeviceAdminPruneBackend>(ports: DeviceAdminPrunePorts<Backend>) {
    function pruneRecord(ownerId: string, backend: Backend, expected: DeviceAdminPruneRecord): boolean {
        if (!expected.id) return false;
        return ports.withRecordLock(ownerId, backend.stateKey, expected.id, () => {
            const current = ports.readDevices(ownerId, backend.stateKey).find(candidate => candidate.id === expected.id);
            if (!current || !ports.sameRecord(current, expected)) return false;
            if (!deviceAdminPruneEligible(backend, current)) return false;
            return ports.removeRecord(ownerId, backend, current);
        });
    }
    function pruneBackend(ownerId: string, backend: Backend, lines: string[]): number {
        let deleted = 0;
        for (const device of ports.readDevices(ownerId, backend.stateKey)) {
            if (pruneRecord(ownerId, backend, device)) {
                deleted += 1;
                lines.push(deviceAdminPrunedLine(device, backend));
            }
        }
        return deleted;
    }
    function owner(cwd: string, profile?: string): { ok: boolean; text: string } {
        const ownerId = ports.resolveOwnerId(cwd, profile);
        const lines = [`owner: ${ownerId}`];
        let deleted = 0;
        for (const backend of ports.backends) deleted += pruneBackend(ownerId, backend, lines);
        if (deleted === 0) lines.push("pruned: 0");
        return { ok: true, text: `${lines.join("\n")}\n` };
    }
    function allProjects(): { ok: boolean; text: string } {
        const lines = ["projects: prune --all-projects"];
        let deleted = 0;
        for (const ownerId of ports.enumerateOwnerIds()) {
            lines.push(`project: ${ownerId}`);
            for (const backend of ports.backends) deleted += pruneBackend(ownerId, backend, lines);
        }
        if (deleted === 0) lines.push("pruned: 0");
        return { ok: true, text: `${lines.join("\n")}\n` };
    }
    return { owner, allProjects };
}
