import { readFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { commandPath, localBinPath, run, runWithTimeout } from "../commands.mjs";
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

export function iosAppiumDiscovery() {
    const ios = iosDiscovery();
    const appium = localBinPath("appium") || commandPath("appium");
    const xcuitestDriver = localBinPath("appium-xcuitest-driver") || commandPath("appium-xcuitest-driver");
    const xcodebuild = commandPath("xcodebuild");
    const missing = [...ios.missing];
    if (!appium) missing.push("appium");
    if (!xcuitestDriver) missing.push("appium-xcuitest-driver");
    if (!xcodebuild) missing.push("xcodebuild");
    return {
        appium,
        xcuitestDriver,
        xcodebuild,
        xcrun: ios.xcrun,
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
            "device_inventory",
            "device_create",
            "device_delete",
            "device_start",
            "device_stop",
            "device_status",
            "device_exec",
            "device_screenshot",
            "device_upload",
            "device_download",
            "device_reset",
            "device_install_app",
            "device_launch_app",
            "mobile_open_url",
            "mobile_install_app",
            "mobile_launch_app",
            "mobile_screenshot",
            "mobile_session_status",
            "mobile_dump_ui",
            "mobile_uninstall_app",
            "mobile_stop_app",
            "mobile_clear_app_data",
        ],
    };
}

function iosDeviceId(name) {
    return `ios-${slug(name)}`;
}

function simctlTarget(device) {
    return device.udid || device.simulatorName || device.name || device.id;
}

function ownerSimulatorPrefix() {
    return `ccc-${ownerId()}-`;
}

function isOwnedSimulatorName(name) {
    return typeof name === "string" && name.startsWith(ownerSimulatorPrefix());
}

function missingPrereqResult(discovery) {
    return textResult(false, `iOS Simulator backend missing prerequisites: ${discovery.missing.join(", ")}`);
}

function unsupportedMobileResult(tool) {
    return textResult(false, `iOS Simulator does not support ${tool} through base simctl; use Appium/XCUITest support when available.`);
}

function unsupportedIosResult(tool, reason) {
    return textResult(false, `iOS Simulator ${tool} is not supported through base simctl in this slice: ${reason}`);
}

function iosAppiumStatus(device) {
    return {
        deviceId: device.id,
        appium: iosAppiumDiscovery(),
        session: device.appium || null,
        automationName: "XCUITest",
        lazy: true,
    };
}

function missingIosAppiumResult(discovery) {
    return textResult(false, `iOS Appium/XCUITest layer missing prerequisites: ${discovery.missing.join(", ")}`);
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

function hostSimulatorInventory(discovery = iosDiscovery()) {
    if (!discovery.available) {
        return {
            available: false,
            missing: discovery.missing,
            devices: {},
            runtimes: [],
            deviceTypes: [],
        };
    }
    const listed = simctlJson(discovery.xcrun, ["list", "-j"]);
    if (listed.error) {
        return {
            available: false,
            missing: [],
            devices: {},
            runtimes: [],
            deviceTypes: [],
            error: listed.error.stderr || listed.error.stdout || `exit ${listed.error.status}`,
        };
    }
    return {
        available: true,
        missing: [],
        devices: listed.value.devices || {},
        runtimes: listed.value.runtimes || [],
        deviceTypes: listed.value.devicetypes || listed.value.deviceTypes || [],
    };
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
        case "device_inventory": {
            const { backend = "ios-simulator" } = args;
            if (backend !== "ios-simulator") return undefined;

            const discovery = iosDiscovery();
            return jsonResult({
                backend,
                ownerId: ownerId(),
                devices: listIosDevices(),
                hostSimulators: hostSimulatorInventory(discovery),
                discovery,
            });
        }

        case "device_create": {
            const { backend, name: deviceName, deviceId, simulatorName, deviceType, runtime, udid, createSimulator = false } = args;
            if (backend !== "ios-simulator") return undefined;

            const id = deviceId || iosDeviceId(deviceName);
            const devices = readIosDevices();
            if (devices.some((device) => device.id === id)) {
                return textResult(false, `Device already exists for this owner: ${id}`);
            }

            const simulatorDisplayName = simulatorName || `${ownerSimulatorPrefix()}${slug(deviceName)}`;
            let createdUdid = udid || null;
            let provisioning = "definition-only";
            if (createSimulator) {
                if (!isOwnedSimulatorName(simulatorDisplayName)) {
                    return textResult(false, `Refusing to create non-owned iOS Simulator name: ${simulatorDisplayName}`);
                }
                if (!deviceType || !runtime) {
                    return textResult(false, "iOS Simulator provisioning requires deviceType and runtime");
                }
                const discovery = iosDiscovery();
                if (!discovery.available) return missingPrereqResult(discovery);
                const r = run(discovery.xcrun, ["simctl", "create", simulatorDisplayName, deviceType, runtime]);
                if (r.status !== 0) return fail(r);
                createdUdid = r.stdout.trim();
                provisioning = "created";
            }

            const device = {
                id,
                name: deviceName,
                backend,
                kind: "mobile",
                platform: "ios",
                ownerId: ownerId(),
                simulatorName: simulatorDisplayName,
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
            const { deviceId, force = false, deleteSimulator = false } = args;
            const devices = readIosDevices();
            const device = devices.find((item) => item.id === deviceId);
            if (!device) return undefined;
            if (!force && device.status !== "stopped") {
                return textResult(false, `Refusing to delete ${deviceId} while status is ${device.status}`);
            }

            if (deleteSimulator) {
                if (!isOwnedSimulatorName(device.simulatorName)) {
                    return textResult(false, `Refusing to delete non-owned iOS Simulator name: ${device.simulatorName}`);
                }
                const discovery = iosDiscovery();
                if (!discovery.available) return missingPrereqResult(discovery);
                if (!device.udid) return textResult(false, `Cannot delete iOS Simulator without udid: ${deviceId}`);
                if (force && device.status !== "stopped") {
                    run(discovery.xcrun, ["simctl", "shutdown", device.udid]);
                }
                const r = run(discovery.xcrun, ["simctl", "delete", device.udid]);
                if (r.status !== 0 && !String(r.stderr || r.stdout).includes("Invalid device")) return fail(r);
            }

            writeIosDevices(devices.filter((item) => item.id !== deviceId));
            return jsonResult({ deleted: deviceId, simulatorDeleted: Boolean(deleteSimulator) });
        }

        case "device_status": {
            const { deviceId } = args;
            const device = findIosDevice(deviceId);
            if (!device) return undefined;
            return jsonResult({ device: reconcileIosDevice(device), backend: iosBackend() });
        }

        case "device_start": {
            const { deviceId, waitForBoot = true, bootTimeoutMs = 60000 } = args;
            const device = findIosDevice(deviceId);
            if (!device) return undefined;

            const discovery = iosDiscovery();
            if (!discovery.available) {
                return missingPrereqResult(discovery);
            }
            if (!isOwnedSimulatorName(device.simulatorName)) {
                return textResult(false, `Refusing to start non-owned iOS Simulator name: ${device.simulatorName}`);
            }

            const target = simctlTarget(device);
            const r = run(discovery.xcrun, ["simctl", "boot", target]);
            if (r.status !== 0 && !String(r.stderr || r.stdout).includes("Unable to boot device in current state: Booted")) {
                return fail(r);
            }

            let boot = { ready: true, skipped: true };
            if (waitForBoot) {
                const bootstatus = runWithTimeout(discovery.xcrun, ["simctl", "bootstatus", target, "-b"], bootTimeoutMs);
                boot = {
                    ready: bootstatus.status === 0,
                    skipped: false,
                    status: bootstatus.status,
                    stdout: bootstatus.stdout,
                    stderr: bootstatus.stderr,
                };
                if (bootstatus.error) boot.error = bootstatus.error;
            }

            const updated = updateIosDevice(deviceId, (item) => ({
                ...item,
                status: boot.ready ? "booted" : "starting",
                bootReady: boot.ready,
                lastBootCheck: boot,
                updatedAt: now(),
            }));
            return jsonResult({ device: updated, boot });
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

        case "device_upload":
        case "device_download": {
            const { deviceId } = args;
            const device = findIosDevice(deviceId);
            if (!device) return undefined;
            return unsupportedIosResult(name, "file transfer requires an app container target or a future guest/file channel");
        }

        case "device_reset": {
            const { deviceId } = args;
            const device = findIosDevice(deviceId);
            if (!device) return undefined;
            return unsupportedIosResult(name, "use a future explicit simulator erase or app-container reset flow");
        }

        case "mobile_screenshot": {
            const { deviceId } = args;
            return handleIosTool("device_screenshot", { deviceId });
        }

        case "mobile_session_status": {
            const { deviceId } = args;
            const device = findIosDevice(deviceId);
            if (!device) return undefined;
            return jsonResult(iosAppiumStatus(device));
        }

        case "mobile_dump_ui": {
            const { deviceId } = args;
            const device = findIosDevice(deviceId);
            if (!device) return undefined;

            const discovery = iosAppiumDiscovery();
            if (!discovery.available) return missingIosAppiumResult(discovery);
            return textResult(
                false,
                "iOS Appium/XCUITest session creation is deferred; mobile_dump_ui will use an owner-scoped Appium session once the iOS session slice is implemented.",
            );
        }

        case "mobile_open_url": {
            const { deviceId, url } = args;
            const device = findIosDevice(deviceId);
            if (!device) return undefined;

            const discovery = iosDiscovery();
            if (!discovery.available) return missingPrereqResult(discovery);

            const r = run(discovery.xcrun, ["simctl", "openurl", simctlTarget(device), url]);
            return r.status === 0 ? jsonResult({ openedUrl: url, provider: "simctl", stdout: r.stdout, stderr: r.stderr }) : fail(r);
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

        case "mobile_install_app": {
            const { deviceId, path } = args;
            return handleIosTool("device_install_app", { deviceId, path });
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

        case "mobile_launch_app": {
            const { deviceId, bundleId } = args;
            return handleIosTool("device_launch_app", { deviceId, bundleId });
        }

        case "mobile_uninstall_app":
        case "mobile_stop_app":
        case "mobile_clear_app_data": {
            const { deviceId } = args;
            const device = findIosDevice(deviceId);
            if (!device) return undefined;
            return unsupportedMobileResult(name);
        }

        case "mobile_tap":
        case "mobile_double_tap":
        case "mobile_long_press":
        case "mobile_swipe":
        case "mobile_type_text":
        case "mobile_key":
        case "mobile_home":
        case "mobile_back":
        case "mobile_forward":
        case "mobile_recents":
        case "mobile_power":
        case "mobile_lock":
        case "mobile_unlock": {
            const { deviceId } = args;
            const device = findIosDevice(deviceId);
            if (!device) return undefined;
            return unsupportedMobileResult(name);
        }

        default:
            return undefined;
    }
}
