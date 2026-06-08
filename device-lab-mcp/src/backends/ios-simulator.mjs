import { readFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { commandPath, run } from "../commands.mjs";
import { ownerId, slug } from "../context.mjs";
import { fail, jsonResult, textResult } from "../responses.mjs";
import { findIosDevice, readIosDevices, updateIosDevice, writeIosDevices } from "../state/ios-state.mjs";

export function iosDiscovery() {
    const xcrun = commandPath("xcrun");
    const missing = [];
    if (!xcrun) missing.push("xcrun");
    return {
        xcrun,
        available: missing.length === 0,
        missing,
    };
}

export function iosBackend() {
    const discovery = iosDiscovery();
    return {
        name: "ios-simulator",
        host: "macos-host",
        creatable: true,
        available: discovery.available,
        lazy: true,
        status: discovery.available ? "available" : "missing-prerequisites",
        missing: discovery.missing,
        tools: { xcrun: discovery.xcrun },
        capabilities: [
            "device_create",
            "device_delete",
            "device_start",
            "device_stop",
            "device_status",
            "device_exec",
            "device_screenshot",
            "device_install_app",
            "device_launch_app",
        ],
    };
}

function iosDeviceId(name) {
    return `ios-${slug(name)}`;
}

function simctlTarget(device) {
    return device.udid || device.simulatorName || device.name || device.id;
}

function missingPrereqResult(discovery) {
    return textResult(false, `iOS Simulator backend missing prerequisites: ${discovery.missing.join(", ")}`);
}

function now() {
    return new Date().toISOString();
}

function simctlJson(xcrun, args) {
    const r = run(xcrun, ["simctl", ...args]);
    if (r.status !== 0) return { error: r };
    try {
        return { value: JSON.parse(r.stdout || "{}") };
    } catch {
        return { error: { ...r, stderr: `Invalid simctl JSON: ${r.stdout}` } };
    }
}

function findRuntimeDevice(simctlList, udid) {
    if (!udid || !simctlList?.devices) return null;
    for (const devices of Object.values(simctlList.devices)) {
        const match = devices.find((device) => device.udid === udid);
        if (match) return match;
    }
    return null;
}

function normalizeSimState(state) {
    if (!state) return "unknown";
    return String(state).toLowerCase() === "booted" ? "booted" : "stopped";
}

function reconcileIosDevice(device) {
    const discovery = iosDiscovery();
    if (!discovery.available || !device.udid) return device;

    const listed = simctlJson(discovery.xcrun, ["list", "devices", "-j"]);
    if (listed.error) return device;

    const simulator = findRuntimeDevice(listed.value, device.udid);
    if (!simulator) return device;

    const status = normalizeSimState(simulator.state);
    if (status === device.status && simulator.name === device.simulatorName) return device;

    return updateIosDevice(device.id, (item) => ({
        ...item,
        simulatorName: simulator.name || item.simulatorName,
        status,
        updatedAt: now(),
    })) || device;
}

export function listIosDevices() {
    return readIosDevices().map((device) => ({ ...reconcileIosDevice(device), ownerId: ownerId() }));
}

export async function handleIosTool(name, args) {
    switch (name) {
        case "device_create": {
            const { backend, name: deviceName, deviceId, simulatorName, deviceType, runtime, udid } = args;
            if (backend !== "ios-simulator") return undefined;

            const id = deviceId || iosDeviceId(deviceName);
            const devices = readIosDevices();
            if (devices.some((device) => device.id === id)) {
                return textResult(false, `Device already exists for this owner: ${id}`);
            }

            const discovery = iosDiscovery();
            let createdUdid = udid || null;
            let provisioning = "definition-only";
            if (!createdUdid && discovery.available && deviceType && runtime) {
                const simulatorDisplayName = simulatorName || `ccc-${ownerId()}-${slug(deviceName)}`;
                const r = run(discovery.xcrun, ["simctl", "create", simulatorDisplayName, deviceType, runtime]);
                if (r.status !== 0) return fail(r);
                createdUdid = r.stdout.trim();
                provisioning = "created";
            } else if (!discovery.available) {
                provisioning = "missing-prerequisites";
            }

            const device = {
                id,
                name: deviceName,
                backend,
                kind: "mobile",
                platform: "ios",
                ownerId: ownerId(),
                simulatorName: simulatorName || `ccc-${ownerId()}-${slug(deviceName)}`,
                deviceType: deviceType || null,
                runtime: runtime || null,
                udid: createdUdid,
                status: "stopped",
                creatable: true,
                provisioning,
                createdAt: now(),
                updatedAt: now(),
            };
            devices.push(device);
            writeIosDevices(devices);
            return jsonResult({ device });
        }

        case "device_delete": {
            const { deviceId, force = false } = args;
            const devices = readIosDevices();
            const device = devices.find((item) => item.id === deviceId);
            if (!device) return undefined;
            if (!force && device.status !== "stopped") {
                return textResult(false, `Refusing to delete ${deviceId} while status is ${device.status}`);
            }

            const discovery = iosDiscovery();
            if (discovery.available && device.udid) {
                if (force && device.status !== "stopped") {
                    run(discovery.xcrun, ["simctl", "shutdown", device.udid]);
                }
                const r = run(discovery.xcrun, ["simctl", "delete", device.udid]);
                if (r.status !== 0 && !String(r.stderr || r.stdout).includes("Invalid device")) return fail(r);
            }

            writeIosDevices(devices.filter((item) => item.id !== deviceId));
            return jsonResult({ deleted: deviceId });
        }

        case "device_status": {
            const { deviceId } = args;
            const device = findIosDevice(deviceId);
            if (!device) return undefined;
            return jsonResult({ device: reconcileIosDevice(device), backend: iosBackend() });
        }

        case "device_start": {
            const { deviceId } = args;
            const device = findIosDevice(deviceId);
            if (!device) return undefined;

            const discovery = iosDiscovery();
            if (!discovery.available) {
                return missingPrereqResult(discovery);
            }

            const r = run(discovery.xcrun, ["simctl", "boot", simctlTarget(device)]);
            if (r.status !== 0 && !String(r.stderr || r.stdout).includes("Unable to boot device in current state: Booted")) {
                return fail(r);
            }

            const updated = updateIosDevice(deviceId, (item) => ({
                ...item,
                status: "booted",
                updatedAt: now(),
            }));
            return jsonResult({ device: updated });
        }

        case "device_stop": {
            const { deviceId } = args;
            const device = findIosDevice(deviceId);
            if (!device) return undefined;

            const discovery = iosDiscovery();
            if (discovery.available) {
                run(discovery.xcrun, ["simctl", "shutdown", simctlTarget(device)]);
            }

            const updated = updateIosDevice(deviceId, (item) => ({
                ...item,
                status: "stopped",
                updatedAt: now(),
            }));
            return jsonResult({ device: updated });
        }

        case "device_exec": {
            const { deviceId, command } = args;
            const device = findIosDevice(deviceId);
            if (!device) return undefined;

            const discovery = iosDiscovery();
            if (!discovery.available) return missingPrereqResult(discovery);

            const r = run(discovery.xcrun, ["simctl", "spawn", simctlTarget(device), "/bin/sh", "-lc", command]);
            return r.status === 0 ? jsonResult({ stdout: r.stdout, stderr: r.stderr, status: r.status }) : fail(r);
        }

        case "device_screenshot": {
            const { deviceId } = args;
            const device = findIosDevice(deviceId);
            if (!device) return undefined;

            const discovery = iosDiscovery();
            if (!discovery.available) {
                return missingPrereqResult(discovery);
            }

            const ssPath = join(tmpdir(), `device_lab_ios_${Date.now()}.png`);
            const r = run(discovery.xcrun, ["simctl", "io", simctlTarget(device), "screenshot", ssPath]);
            if (r.status !== 0) return fail(r);
            const base64 = readFileSync(ssPath).toString("base64");
            try { unlinkSync(ssPath); } catch { /* ignore */ }
            return { content: [{ type: "image", data: base64, mimeType: "image/png" }] };
        }

        case "device_install_app": {
            const { deviceId, path } = args;
            const device = findIosDevice(deviceId);
            if (!device) return undefined;

            const discovery = iosDiscovery();
            if (!discovery.available) return missingPrereqResult(discovery);

            const r = run(discovery.xcrun, ["simctl", "install", simctlTarget(device), path]);
            return r.status === 0 ? jsonResult({ installed: path, stdout: r.stdout, stderr: r.stderr }) : fail(r);
        }

        case "device_launch_app": {
            const { deviceId, bundleId } = args;
            const device = findIosDevice(deviceId);
            if (!device) return undefined;

            const discovery = iosDiscovery();
            if (!discovery.available) return missingPrereqResult(discovery);

            const r = run(discovery.xcrun, ["simctl", "launch", simctlTarget(device), bundleId]);
            return r.status === 0 ? jsonResult({ launched: bundleId, stdout: r.stdout, stderr: r.stderr }) : fail(r);
        }

        default:
            return undefined;
    }
}
