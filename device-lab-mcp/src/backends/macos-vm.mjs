import { commandPath, run } from "../commands.mjs";
import { ownerId, slug } from "../context.mjs";
import { fail, jsonResult, textResult } from "../responses.mjs";
import { findMacosDevice, readMacosDevices, updateMacosDevice, writeMacosDevices } from "../state/macos-state.mjs";
import { homedir } from "os";
import { join } from "path";

const PROVIDERS = [
    {
        name: "tart",
        command: "tart",
        startArgs: (instance) => ["run", instance],
        stopArgs: (instance) => ["stop", instance],
    },
    {
        name: "vz",
        command: "vz",
        startArgs: (instance) => ["start", instance],
        stopArgs: (instance) => ["stop", instance],
    },
    {
        name: "utmctl",
        command: "utmctl",
        startArgs: (instance) => ["start", instance],
        stopArgs: (instance) => ["stop", instance],
    },
];

function providerCandidates() {
    return PROVIDERS
        .map((provider) => ({ ...provider, command: commandPath(provider.command) }))
        .filter((provider) => provider.command);
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
            "device_exec",
            "device_screenshot",
            "device_upload",
            "device_download",
        ],
    };
}

function macosDeviceId(name) {
    return `macos-${slug(name)}`;
}

function macosWorkspaceDir(device) {
    return join(homedir(), ".ccc/devices/owners", ownerId(), "macos", device.id);
}

function macosToolsDir(device) {
    return join(macosWorkspaceDir(device), "tools");
}

function macosHelperMetadata(device) {
    return {
        workspaceDir: macosWorkspaceDir(device),
        toolsDir: macosToolsDir(device),
        hostHelperScript: join(macosToolsDir(device), "ccc-guest-helper.sh"),
        status: "planned",
        requiredFor: ["device_exec", "device_screenshot", "device_upload", "device_download"],
    };
}

function providerByName(name) {
    return PROVIDERS.find((provider) => provider.name === name);
}

export function macosProviderPlan(device, discovery = macosDiscovery()) {
    const requestedProvider = device.provider || "auto";
    const selected = requestedProvider === "auto"
        ? discovery.providers[0]
        : discovery.providers.find((provider) => provider.name === requestedProvider);
    const catalog = selected ? providerByName(selected.name) : null;
    const instance = device.providerInstance || `ccc-${ownerId()}-${device.id}`;
    const missing = [...discovery.missing];
    if (discovery.hostSupported && !selected) {
        const providerMissing = requestedProvider === "auto" ? "macos-vm-provider" : `macos-vm-provider:${requestedProvider}`;
        if (!missing.includes(providerMissing)) missing.push(providerMissing);
    }
    const command = selected?.command || null;
    return {
        requestedProvider,
        selectedProvider: selected?.name || null,
        providerCommand: command,
        providerInstance: instance,
        workspaceDir: macosWorkspaceDir(device),
        image: device.image || null,
        memoryMb: device.memoryMb,
        cpus: device.cpus,
        helper: macosHelperMetadata(device),
        available: missing.length === 0 && Boolean(catalog && command),
        missing,
        startCommand: catalog && command ? { command, args: catalog.startArgs(instance) } : null,
        stopCommand: catalog && command ? { command, args: catalog.stopArgs(instance) } : null,
        deferred: [
            "base-image-create",
            "snapshot-clone",
            "guest-helper",
        ],
    };
}

function deviceWithPlan(device) {
    return {
        ...device,
        providerPlan: macosProviderPlan(device),
    };
}

function helperRequiredResult(device, toolName) {
    return textResult(false, `macOS VM ${toolName} requires the future CCC guest helper. Workspace: ${macosWorkspaceDir(device)}`);
}

export function listMacosDevices() {
    return readMacosDevices().map((device) => ({ ...device, ownerId: ownerId(), providerPlan: macosProviderPlan(device) }));
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
                providerInstance: `ccc-${ownerId()}-${id}`,
                helper: macosHelperMetadata({ id }),
                status: "stopped",
                creatable: true,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            };
            devices.push(device);
            writeMacosDevices(devices);
            return jsonResult({ device: deviceWithPlan(device) });
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
            return jsonResult({ device: deviceWithPlan(device), backend: macosBackend() });
        }

        case "device_start": {
            const { deviceId } = args;
            const device = findMacosDevice(deviceId);
            if (!device) return undefined;

            const plan = macosProviderPlan(device);
            if (!plan.available) {
                return textResult(false, `macOS VM backend missing prerequisites: ${plan.missing.join(", ")}`);
            }

            const r = run(plan.startCommand.command, plan.startCommand.args);
            if (r.status !== 0) return fail(r);

            const updated = updateMacosDevice(deviceId, (item) => ({
                ...item,
                provider: plan.selectedProvider,
                providerInstance: plan.providerInstance,
                helper: macosHelperMetadata(item),
                status: "running",
                updatedAt: new Date().toISOString(),
            }));
            return jsonResult({ device: deviceWithPlan(updated) });
        }

        case "device_stop": {
            const { deviceId } = args;
            const device = findMacosDevice(deviceId);
            if (!device) return undefined;

            const plan = macosProviderPlan(device);
            if (plan.stopCommand && device.providerInstance) {
                const r = run(plan.stopCommand.command, plan.stopCommand.args);
                if (r.status !== 0) return fail(r);
            }

            const updated = updateMacosDevice(deviceId, (item) => ({
                ...item,
                status: "stopped",
                updatedAt: new Date().toISOString(),
            }));
            return jsonResult({ device: deviceWithPlan(updated) });
        }

        case "device_exec":
        case "device_screenshot":
        case "device_upload":
        case "device_download": {
            const { deviceId } = args;
            const device = findMacosDevice(deviceId);
            if (!device) return undefined;
            return helperRequiredResult(device, name);
        }

        default:
            return undefined;
    }
}
