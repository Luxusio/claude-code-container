import { commandPath, run } from "../commands.mjs";
import { ownerId, slug } from "../context.mjs";
import { fail, jsonResult, textResult } from "../responses.mjs";
import { findMacosDevice, readMacosDevices, updateMacosDevice, writeMacosDevices } from "../state/macos-state.mjs";

function providerCandidates() {
    return [
        { name: "tart", command: commandPath("tart") },
        { name: "vz", command: commandPath("vz") },
        { name: "utmctl", command: commandPath("utmctl") },
    ].filter((provider) => provider.command);
}

export function macosDiscovery() {
    const hostSupported = process.platform === "darwin";
    const providers = hostSupported ? providerCandidates() : [];
    const missing = [];
    if (!hostSupported) missing.push("macos-host");
    if (hostSupported && providers.length === 0) missing.push("macos-vm-provider");
    return {
        hostSupported,
        providers,
        available: hostSupported && providers.length > 0,
        missing,
    };
}

export function macosBackend() {
    const discovery = macosDiscovery();
    return {
        name: "macos-vm",
        host: "macos-host",
        creatable: true,
        available: discovery.available,
        lazy: true,
        status: discovery.available ? "available" : "missing-prerequisites",
        missing: discovery.missing,
        providers: discovery.providers,
        capabilities: [
            "device_create",
            "device_delete",
            "device_start",
            "device_stop",
            "device_status",
        ],
    };
}

function macosDeviceId(name) {
    return `macos-${slug(name)}`;
}

export function listMacosDevices() {
    return readMacosDevices().map((device) => ({ ...device, ownerId: ownerId() }));
}

export async function handleMacosTool(name, args) {
    switch (name) {
        case "device_create": {
            const { backend, name: deviceName, deviceId, provider = "auto", image = null, memoryMb = 4096, cpus = 4 } = args;
            if (backend !== "macos-vm") return undefined;

            const id = deviceId || macosDeviceId(deviceName);
            const devices = readMacosDevices();
            if (devices.some((device) => device.id === id)) {
                return textResult(false, `Device already exists for this owner: ${id}`);
            }

            const device = {
                id,
                name: deviceName,
                backend,
                kind: "desktop",
                platform: "macos",
                ownerId: ownerId(),
                provider,
                image,
                memoryMb,
                cpus,
                status: "stopped",
                creatable: true,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            };
            devices.push(device);
            writeMacosDevices(devices);
            return jsonResult({ device });
        }

        case "device_delete": {
            const { deviceId, force = false } = args;
            const devices = readMacosDevices();
            const device = devices.find((item) => item.id === deviceId);
            if (!device) return undefined;
            if (!force && device.status !== "stopped") {
                return textResult(false, `Refusing to delete ${deviceId} while status is ${device.status}`);
            }
            writeMacosDevices(devices.filter((item) => item.id !== deviceId));
            return jsonResult({ deleted: deviceId });
        }

        case "device_status": {
            const { deviceId } = args;
            const device = findMacosDevice(deviceId);
            if (!device) return undefined;
            return jsonResult({ device, backend: macosBackend() });
        }

        case "device_start": {
            const { deviceId } = args;
            const device = findMacosDevice(deviceId);
            if (!device) return undefined;

            const discovery = macosDiscovery();
            if (!discovery.available) {
                return textResult(false, `macOS VM backend missing prerequisites: ${discovery.missing.join(", ")}`);
            }

            return textResult(
                false,
                "macOS VM provider start is not implemented yet; provider discovery is available and real boot is deferred to a provider-specific slice.",
            );
        }

        case "device_stop": {
            const { deviceId } = args;
            const device = findMacosDevice(deviceId);
            if (!device) return undefined;

            const discovery = macosDiscovery();
            const provider = discovery.providers.find((item) => item.name === device.provider);
            if (provider && device.providerInstance) {
                const r = run(provider.command, ["stop", device.providerInstance]);
                if (r.status !== 0) return fail(r);
            }

            const updated = updateMacosDevice(deviceId, (item) => ({
                ...item,
                status: "stopped",
                updatedAt: new Date().toISOString(),
            }));
            return jsonResult({ device: updated });
        }

        default:
            return undefined;
    }
}
