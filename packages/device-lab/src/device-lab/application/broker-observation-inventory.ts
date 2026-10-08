import type { FocusedInventoryRequest } from "../domain/broker-observation.js";
import type { FocusedInventoryPorts, OwnerInventoryPorts } from "../ports/broker-observation.js";

export function createOwnerInventory<File, Device>(ports: OwnerInventoryPorts<File, Device>, settings: {
    stateKeys: readonly string[]; maxBytes: number; maxDevices: number;
}) {
    return function ownerInventory(ownerId: string, redactSecrets = false) {
        const root = ports.root();
        const backends = settings.stateKeys.map(stateKey => {
            const file = ports.file(root, ownerId, stateKey);
            if (!ports.exists(file)) return { stateKey, devices: [] as Device[], exists: false as const };
            try {
                const stat = ports.stat(file);
                if (stat.size > settings.maxBytes) {
                    return { stateKey, devices: [] as Device[], exists: true as const, truncated: true as const,
                        error: "inventory-file-too-large", maxBytes: settings.maxBytes, bytes: stat.size };
                }
                const devices = ports.read(file, settings.maxBytes);
                return { stateKey, devices: redactSecrets
                    ? devices.slice(0, settings.maxDevices).map(ports.redact)
                    : devices.slice(0, settings.maxDevices),
                exists: true as const, truncated: devices.length > settings.maxDevices,
                totalDevices: devices.length, maxDevices: settings.maxDevices };
            } catch (error) {
                return { stateKey, devices: [] as Device[], exists: true as const, error: ports.errorCode(error) || "inventory-read-failed" };
            }
        });
        return { ownerId, root, ownerRoot: ports.ownerRoot(root, ownerId), backends };
    };
}

export function createFocusedInventory<Device, Context, Host extends { devices: unknown }, Choices extends object>(
    ports: FocusedInventoryPorts<Device, Context, Host, Choices>,
) {
    return function focusedInventory(ownerId: string, parsed: FocusedInventoryRequest, context: Context) {
        const inventory = ports.inventory(ownerId);
        const backends = parsed.stateKey ? inventory.backends.filter(entry => entry.stateKey === parsed.stateKey) : inventory.backends;
        const hostInventory = parsed.backend === "android-device" ? ports.androidHost(context) : null;
        const creationChoices = parsed.backend === "android-emulator" ? ports.androidChoices(context) : null;
        return {
            ownerId, tool: parsed.tool, backend: parsed.backend,
            devices: parsed.stateKey ? (backends[0]?.devices || []) : undefined,
            backends: backends.map(entry => ({ ...entry, backend: ports.backend(entry) })),
            ...(hostInventory ? { hostDevices: hostInventory.devices, hostInventory } : {}),
            ...(creationChoices || {}),
        };
    };
}
