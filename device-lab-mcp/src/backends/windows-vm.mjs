import { commandPath } from "../commands.mjs";
import { readWindowsVmDevices } from "../state/windows-vm-state.mjs";

const CAPABILITIES = [
    "device_inventory",
    "device_create",
    "device_delete",
    "device_start",
    "device_stop",
    "device_reboot",
    "device_status",
    "device_exec",
    "device_upload",
    "device_download",
    "device_snapshot_list",
    "device_snapshot_create",
    "device_snapshot_restore",
    "device_snapshot_delete",
];

export function windowsVmBackend() {
    const hostSupported = process.platform === "win32";
    const powershell = hostSupported
        ? commandPath("powershell.exe") || commandPath("pwsh") || commandPath("powershell")
        : null;
    const missing = [
        ...(hostSupported ? [] : ["windows-host"]),
        ...(hostSupported && !powershell ? ["powershell"] : []),
    ];
    return {
        name: "windows-vm",
        host: "windows-host",
        provider: "hyper-v",
        creatable: true,
        available: missing.length === 0,
        lazy: true,
        status: missing.length === 0 ? "available" : "missing-prerequisites",
        missing,
        tools: { powershell },
        capabilities: CAPABILITIES,
    };
}

export function listWindowsVmDevices() {
    return readWindowsVmDevices();
}
