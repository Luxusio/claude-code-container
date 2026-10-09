import { admitDeviceAdminInventoryCommand, classifyDeviceAdminTools, deviceAdminLabel, type DeviceAdminInventoryCommand } from "../domain/device-admin-inventory.js";
import type {
    DeviceAdminBackend,
    DeviceAdminBackendSnapshot,
    DeviceAdminInventoryPorts,
    DeviceAdminOwnerSnapshot,
} from "../ports/device-admin-inventory.js";

export function createDeviceAdminInventory<Backend extends DeviceAdminBackend>(ports: DeviceAdminInventoryPorts<Backend>) {
    function snapshot(cwd: string, profile?: string): { ownerId: string; backends: DeviceAdminBackendSnapshot<Backend>[] } {
        const ownerId = ports.resolveOwnerId(cwd, profile);
        const backends = ports.backends.map((backend) => {
            const devices = ports.readDevices(ownerId, backend.stateKey);
            const tools = Object.fromEntries(backend.tools.map((tool) => [tool, ports.commandPath(tool)])) as Record<string, string | null>;
            const availability = classifyDeviceAdminTools(backend, tools);
            return { ...backend, devices, tools: availability.tools, missing: availability.missing, available: availability.available } as DeviceAdminBackendSnapshot<Backend>;
        });
        return { ownerId, backends };
    }

    function allOwnersSnapshot(): { owners: DeviceAdminOwnerSnapshot[] } {
        const owners = ports.enumerateOwnerIds().map((ownerId) => ({
            ownerId,
            backends: ports.backends.map((backend) => ({
                stateKey: backend.stateKey,
                name: backend.name,
                devices: ports.readDevices(ownerId, backend.stateKey),
            })),
        }));
        return { owners };
    }

    function formatStatus(cwd: string, profile?: string): string {
        const inventory = snapshot(cwd, profile);
        const lines = [
            "=== CCC Devices Status ===",
            "",
            `owner: ${inventory.ownerId}`,
            "",
            "Backends:",
        ];
        for (const backend of inventory.backends) {
            lines.push(`  ${backend.name}: ${backend.devices.length} device(s), ${backend.available ? "available" : `missing ${backend.missing.join(", ")}`}`);
        }
        return `${lines.join("\n")}\n`;
    }

    function formatList(cwd: string, profile?: string): string {
        const inventory = snapshot(cwd, profile);
        const lines = [
            "=== CCC Devices ===",
            "",
            `owner: ${inventory.ownerId}`,
            "",
        ];
        for (const backend of inventory.backends) {
            lines.push(`${backend.name}:`);
            if (backend.devices.length === 0) {
                lines.push("  (none)");
            } else {
                for (const device of backend.devices) lines.push(`  ${deviceAdminLabel(device)}`);
            }
        }
        return `${lines.join("\n")}\n`;
    }

    function formatAllProjectsList(): string {
        const snapshot = allOwnersSnapshot();
        const lines = [
            "=== CCC Devices: All Projects ===",
            "",
        ];
        if (snapshot.owners.length === 0) {
            lines.push("(none)");
            return `${lines.join("\n")}\n`;
        }
        for (const owner of snapshot.owners) {
            lines.push(`project: ${owner.ownerId}`);
            for (const backend of owner.backends) {
                lines.push(`${backend.name}:`);
                if (backend.devices.length === 0) {
                    lines.push("  (none)");
                } else {
                    for (const device of backend.devices) lines.push(`  ${deviceAdminLabel(device)}`);
                }
            }
            lines.push("");
        }
        return `${lines.join("\n").trimEnd()}\n`;
    }

    function command(args: string[], cwd: string, profile?: string, admission: DeviceAdminInventoryCommand = admitDeviceAdminInventoryCommand(args)): { ok: boolean; text: string } | null {
        switch (admission) {
        case "status": return { ok: true, text: formatStatus(cwd, profile) };
        case "list": return { ok: true, text: formatList(cwd, profile) };
        case "all-projects": return { ok: true, text: formatAllProjectsList() };
        case "invalid-list": return { ok: false, text: "Usage: ccc devices list [--all-projects]" };
        case null: return null;
        }
    }

    return { snapshot, allOwnersSnapshot, formatStatus, formatList, formatAllProjectsList, command };
}
