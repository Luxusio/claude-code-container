import type { DeviceAdminBackend } from "../domain/device-admin-inventory.js";
export type { DeviceAdminBackend, DeviceAdminToolSnapshot } from "../domain/device-admin-inventory.js";

export type DeviceAdminRecord = Record<string, unknown> & { id?: string; status?: string };

export type DeviceAdminInventoryPorts<Backend extends DeviceAdminBackend = DeviceAdminBackend> = {
    backends: readonly Backend[];
    resolveOwnerId(cwd: string, profile?: string): string;
    enumerateOwnerIds(): string[];
    readDevices(ownerId: string, stateKey: string): DeviceAdminRecord[];
    commandPath(tool: string): string | null;
};

export type DeviceAdminBackendSnapshot<Backend extends DeviceAdminBackend = DeviceAdminBackend> =
    Backend extends DeviceAdminBackend ? Omit<Backend, "tools"> & {
        devices: DeviceAdminRecord[];
        tools: Record<string, string | null>;
        missing: string[];
        available: boolean;
    } : never;

export type DeviceAdminOwnerSnapshot = {
    ownerId: string;
    backends: { stateKey: string; name: string; devices: DeviceAdminRecord[] }[];
};

