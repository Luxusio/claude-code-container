import { createDeviceObservation } from "../application/device-observation.mjs";
import { readPhysicalLeases as observationPhysicalLeases } from "../state/physical-lease-store.mjs";
import { ownerId } from "../context.mjs";
import { commandPath } from "../commands.mjs";
import { readWindowsVmDevices } from "../state/windows-vm-state.mjs";

const CAPABILITIES = [
    "device_list_files",
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
    "device_screenshot",
    "device_click",
    "device_double_click",
    "device_drag",
    "device_focus_window",
    "device_key",
    "device_type",
    "device_scroll",
    "device_cursor_position",
    "device_window_list",
    "device_snapshot_list",
    "device_snapshot_create",
    "device_snapshot_restore",
    "device_snapshot_delete",
];

export function windowsVmBackend() { return deviceObservation.backend(); }

export function listWindowsVmDevices() { return deviceObservation.owned(); }

const deviceObservation = createDeviceObservation({ kind: "windows-vm", ownerId: () => ownerId(), now: () => Date.now(), readPhysicalLeases: backend => observationPhysicalLeases(backend), capabilities: CAPABILITIES, platform: process.platform, executable: name => commandPath(name), records: () => readWindowsVmDevices() });
