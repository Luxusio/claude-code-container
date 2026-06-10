import { commandPath, run } from "../commands.mjs";
import { ownerId, slug } from "../context.mjs";
import { fail, jsonResult, textResult } from "../responses.mjs";
import { findMacosDevice, readMacosDevices, updateMacosDevice, writeMacosDevices } from "../state/macos-state.mjs";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync } from "fs";
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
            "device_record_video_start",
            "device_record_video_stop",
            "device_record_video_status",
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

function ensureMacosWorkspace(device) {
    mkdirSync(macosWorkspaceDir(device), { recursive: true });
    mkdirSync(macosToolsDir(device), { recursive: true });
}

function macosHelperMetadata(device) {
    ensureMacosWorkspace(device);
    return {
        workspaceDir: macosWorkspaceDir(device),
        toolsDir: macosToolsDir(device),
        hostHelperScript: join(macosToolsDir(device), "ccc-guest-helper.sh"),
        bridge: device.ssh ? "ssh" : "missing",
        ssh: device.ssh || null,
        status: device.ssh ? "ssh-configured" : "planned",
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
    return textResult(false, `macOS VM ${toolName} requires SSH bridge metadata. Configure sshHost, sshUser, and optional sshPort/sshKeyPath on the device. Workspace: ${macosWorkspaceDir(device)}`);
}

function sshDiscovery() {
    const ssh = commandPath("ssh");
    const scp = commandPath("scp");
    const missing = [];
    if (!ssh) missing.push("ssh");
    if (!scp) missing.push("scp");
    return { ssh, scp, available: missing.length === 0, missing };
}

function sshTarget(device) {
    if (!device.ssh?.host || !device.ssh?.user) return null;
    return `${device.ssh.user}@${device.ssh.host}`;
}

function sshBaseArgs(device) {
    const args = [];
    if (device.ssh?.keyPath) args.push("-i", device.ssh.keyPath);
    if (device.ssh?.port) args.push("-p", String(device.ssh.port));
    args.push("-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no");
    return args;
}

function scpBaseArgs(device) {
    const args = [];
    if (device.ssh?.keyPath) args.push("-i", device.ssh.keyPath);
    if (device.ssh?.port) args.push("-P", String(device.ssh.port));
    args.push("-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no");
    return args;
}

function sshBridge(device, toolName) {
    const target = sshTarget(device);
    if (!target) return { error: helperRequiredResult(device, toolName) };
    const discovery = sshDiscovery();
    if (!discovery.available) {
        return { error: textResult(false, `macOS VM SSH bridge missing prerequisites: ${discovery.missing.join(", ")}`) };
    }
    return { target, discovery };
}

export function listMacosDevices() {
    return readMacosDevices().map((device) => ({ ...device, ownerId: ownerId(), providerPlan: macosProviderPlan(device) }));
}

export async function handleMacosTool(name, args) {
    switch (name) {
        case "device_create": {
            const { backend, name: deviceName, deviceId, provider = "auto", image = null, memoryMb = 4096, cpus = 4, sshHost, sshPort = 22, sshUser, sshKeyPath } = args;
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
                ssh: sshHost && sshUser ? {
                    host: sshHost,
                    port: sshPort,
                    user: sshUser,
                    keyPath: sshKeyPath || null,
                } : null,
                helper: macosHelperMetadata({ id, ssh: sshHost && sshUser ? { host: sshHost, port: sshPort, user: sshUser, keyPath: sshKeyPath || null } : null }),
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

        case "device_exec": {
            const { deviceId, command } = args;
            const device = findMacosDevice(deviceId);
            if (!device) return undefined;
            const bridge = sshBridge(device, name);
            if (bridge.error) return bridge.error;
            const r = run(bridge.discovery.ssh, [...sshBaseArgs(device), bridge.target, command]);
            return jsonResult({ stdout: r.stdout, stderr: r.stderr, status: r.status, provider: "ssh" });
        }

        case "device_upload": {
            const { deviceId, localPath, remotePath } = args;
            const device = findMacosDevice(deviceId);
            if (!device) return undefined;
            const bridge = sshBridge(device, name);
            if (bridge.error) return bridge.error;
            const r = run(bridge.discovery.scp, [...scpBaseArgs(device), localPath, `${bridge.target}:${remotePath}`]);
            return r.status === 0 ? jsonResult({ uploaded: { localPath, remotePath }, stdout: r.stdout, stderr: r.stderr, provider: "scp" }) : fail(r);
        }

        case "device_download": {
            const { deviceId, remotePath, localPath } = args;
            const device = findMacosDevice(deviceId);
            if (!device) return undefined;
            const bridge = sshBridge(device, name);
            if (bridge.error) return bridge.error;
            const r = run(bridge.discovery.scp, [...scpBaseArgs(device), `${bridge.target}:${remotePath}`, localPath]);
            return r.status === 0 ? jsonResult({ downloaded: { remotePath, localPath }, stdout: r.stdout, stderr: r.stderr, provider: "scp" }) : fail(r);
        }

        case "device_screenshot": {
            const { deviceId } = args;
            const device = findMacosDevice(deviceId);
            if (!device) return undefined;
            const bridge = sshBridge(device, name);
            if (bridge.error) return bridge.error;
            ensureMacosWorkspace(device);
            const localPath = join(macosWorkspaceDir(device), `screenshot-${randomUUID()}.png`);
            const remotePath = `/tmp/ccc-${device.id}-screenshot.png`;
            const capture = run(bridge.discovery.ssh, [...sshBaseArgs(device), bridge.target, `screencapture -x ${remotePath}`]);
            if (capture.status !== 0) return fail(capture);
            const copy = run(bridge.discovery.scp, [...scpBaseArgs(device), `${bridge.target}:${remotePath}`, localPath]);
            if (copy.status !== 0) return fail(copy);
            if (!existsSync(localPath)) return textResult(false, `macOS VM screenshot output missing: ${localPath}`);
            return { content: [{ type: "image", data: readFileSync(localPath).toString("base64"), mimeType: "image/png" }] };
        }

        case "device_record_video_start":
        case "device_record_video_stop":
        case "device_record_video_status": {
            const { deviceId } = args;
            const device = findMacosDevice(deviceId);
            if (!device) return undefined;
            return textResult(false, "macOS VM video recording is not supported yet; it requires a future SSH or guest-helper recording channel.");
        }

        default:
            return undefined;
    }
}
