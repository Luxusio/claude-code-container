import { createHash } from "crypto";
import { commandPath, run } from "../commands.mjs";
import { ownerId, slug } from "../context.mjs";
import { jsonResult, textResult } from "../responses.mjs";
import { findIosRealDevice, readIosRealDevices, updateIosRealDevice, writeIosRealDevices } from "../state/ios-device-state.mjs";
import { claimPhysicalLease, releasePhysicalLease } from "../state/physical-lease-store.mjs";
import { iosAppiumDiscovery, iosDiscovery } from "./ios-simulator.mjs";

const IOS_REAL_CAPABILITIES = [
    "device_inventory", "device_attach", "device_detach", "device_start", "device_stop",
    "device_status", "mobile_session_status", "mobile_dump_ui",
    "device_exec", "device_screenshot", "device_install_app", "device_launch_app",
    "mobile_install_app", "mobile_launch_app", "mobile_screenshot",
];

export function iosRealBackend() {
    const discovery = iosRealDiscovery();
    return {
        name: "ios-device",
        host: "macos-host-usb-xcode",
        creatable: false,
        attachable: true,
        available: discovery.available,
        lazy: true,
        status: discovery.available ? "available" : "missing-prerequisites",
        missing: discovery.missing,
        tools: { xcrun: discovery.xcrun, xcodebuild: discovery.xcodebuild },
        capabilities: IOS_REAL_CAPABILITIES,
    };
}

function iosRealDiscovery() {
    const ios = iosDiscovery();
    const xcodebuild = commandPath("xcodebuild");
    const missing = [...ios.missing];
    if (!xcodebuild) missing.push("xcodebuild");
    return {
        xcrun: ios.xcrun,
        xcodebuild,
        available: missing.length === 0,
        missing,
    };
}

function now() {
    return new Date().toISOString();
}

function iosRealDeviceId(nameOrUdid) {
    return `ios-device-${slug(nameOrUdid)}`;
}

function appiumPortForDevice(id) {
    const hash = createHash("sha256").update(`${ownerId()}:ios-device:${id}`).digest();
    return 32000 + (hash.readUInt16BE(0) % 6000);
}

function parseXctraceDevices(text) {
    return String(text || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.endsWith(":") && !line.includes("Simulator"))
        .map((line) => {
            const matches = [...line.matchAll(/\(([^()]*)\)/g)].map((match) => match[1]);
            const udid = matches.find((value) => /^[A-Fa-f0-9-]{8,}$/.test(value));
            if (!udid) return null;
            const version = matches.find((value) => value !== udid && /\d/.test(value)) || null;
            const name = line.split(" (")[0].trim();
            if (!/\b(iPhone|iPad|iPod)\b/i.test(name)) return null;
            return { name, udid, version, raw: line };
        })
        .filter(Boolean);
}

function hostIosDevices(discovery = iosRealDiscovery()) {
    if (!discovery.xcrun) return { available: false, missing: ["xcrun"], devices: [] };
    const r = run(discovery.xcrun, ["xctrace", "list", "devices"]);
    if (r.status !== 0) {
        return {
            available: false,
            missing: [],
            devices: [],
            error: r.stderr || r.stdout || `exit ${r.status}`,
        };
    }
    return { available: true, missing: [], devices: parseXctraceDevices(r.stdout) };
}

function unsupported(tool) {
    return textResult(false, `iOS real devices do not support ${tool} through base simctl; use Appium/XCUITest or Xcode device tooling where available.`);
}

function appiumStatus(device) {
    const discovery = iosAppiumDiscovery();
    return {
        deviceId: device.id,
        appium: discovery,
        session: device.appium || null,
        automationName: "XCUITest",
        lazy: true,
        physical: true,
    };
}

function clearVolatileMetadata(deviceId) {
    return updateIosRealDevice(deviceId, (item) => ({
        ...item,
        status: "attached",
        pid: null,
        appium: null,
        recording: null,
        updatedAt: now(),
    }));
}

function stopVolatileProcesses(device) {
    if (device.recording?.pid) {
        try { process.kill(device.recording.pid, "SIGINT"); } catch { /* ignore stale recorder */ }
    }
    if (device.appium?.serverPid) {
        try { process.kill(device.appium.serverPid); } catch { /* ignore stale appium */ }
    }
}

export function listIosRealDevices() {
    return readIosRealDevices().map((device) => ({ ...device, ownerId: ownerId() }));
}

export async function handleIosRealTool(name, args) {
    switch (name) {
        case "device_inventory": {
            const { backend = "ios-device" } = args;
            if (backend !== "ios-device") return undefined;
            const discovery = iosRealDiscovery();
            return jsonResult({
                backend,
                ownerId: ownerId(),
                devices: listIosRealDevices(),
                hostDevices: hostIosDevices(discovery),
                discovery,
            });
        }

        case "device_attach": {
            const { backend, name: deviceName, deviceId, udid } = args;
            if (backend !== "ios-device") return undefined;
            if (!udid) return textResult(false, "iOS real-device attach requires udid");
            const discovery = iosRealDiscovery();
            if (!discovery.xcrun) return textResult(false, "iOS real-device backend missing prerequisites: xcrun");
            const inventory = hostIosDevices(discovery);
            const hostDevice = inventory.devices.find((device) => device.udid === udid);
            if (!hostDevice) return textResult(false, `iOS device is not visible to xctrace: ${udid}`);

            const id = deviceId || iosRealDeviceId(deviceName || hostDevice.name || udid);
            const devices = readIosRealDevices();
            if (devices.some((device) => device.id === id)) return textResult(false, `Device already exists for this owner: ${id}`);
            if (devices.some((device) => device.udid === udid)) return textResult(false, `iOS UDID already attached for this owner: ${udid}`);
            const lease = claimPhysicalLease("ios-device", udid, id);
            if (!lease.ok) {
                return textResult(false, `iOS UDID is already attached by another CCC owner: ${udid}`);
            }

            const device = {
                id,
                name: deviceName || hostDevice.name || udid,
                backend,
                kind: "mobile",
                platform: "ios",
                physical: true,
                ownerId: ownerId(),
                udid,
                hostDetails: hostDevice,
                appiumPort: appiumPortForDevice(id),
                appium: null,
                recording: null,
                status: "attached",
                creatable: false,
                attachable: true,
                attachedAt: now(),
                updatedAt: now(),
            };
            writeIosRealDevices([...devices, device]);
            return jsonResult({ device });
        }

        case "device_detach": {
            const { deviceId } = args;
            const devices = readIosRealDevices();
            const device = devices.find((item) => item.id === deviceId);
            if (!device) return undefined;
            stopVolatileProcesses(device);
            writeIosRealDevices(devices.filter((item) => item.id !== deviceId));
            releasePhysicalLease("ios-device", device.udid, deviceId);
            return jsonResult({ detached: deviceId, physicalDevicePoweredOff: false });
        }

        case "device_start": {
            const { deviceId } = args;
            const device = findIosRealDevice(deviceId);
            if (!device) return undefined;
            return jsonResult({ device, started: false, alreadyAttached: true, physicalDevicePoweredOnByMcp: false });
        }

        case "device_stop": {
            const { deviceId } = args;
            const device = findIosRealDevice(deviceId);
            if (!device) return undefined;
            stopVolatileProcesses(device);
            const updated = clearVolatileMetadata(deviceId);
            return jsonResult({ device: updated, stopped: false, detached: false, physicalDevicePoweredOff: false });
        }

        case "device_status": {
            const { deviceId } = args;
            const device = findIosRealDevice(deviceId);
            if (!device) return undefined;
            const discovery = iosRealDiscovery();
            const host = discovery.xcrun ? hostIosDevices(discovery).devices.find((item) => item.udid === device.udid) || null : null;
            return jsonResult({ device, backend: iosRealBackend(), hostDevice: host, appium: appiumStatus(device) });
        }

        case "mobile_session_status": {
            const { deviceId } = args;
            const device = findIosRealDevice(deviceId);
            if (!device) return undefined;
            return jsonResult(appiumStatus(device));
        }

        case "device_exec":
        case "device_screenshot":
        case "device_install_app":
        case "device_launch_app":
        case "mobile_install_app":
        case "mobile_launch_app":
        case "mobile_screenshot":
        case "mobile_dump_ui": {
            const { deviceId } = args;
            const device = findIosRealDevice(deviceId);
            if (!device) return undefined;
            return unsupported(name);
        }

        default:
            return undefined;
    }
}
