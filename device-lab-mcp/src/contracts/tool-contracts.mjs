function objectValue(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function contractError(tool, detail, payload) {
    const keys = objectValue(payload) ? Object.keys(payload).sort().join(", ") : typeof payload;
    return new Error(`${tool} response contract violation: ${detail}; received keys: ${keys}`);
}

const contractGroups = {
    "backend-catalog-v1": ["device_backends"],
    "broker-status-v1": ["device_broker_status"],
    "device-list-v1": ["device_list"],
    "device-inventory-v1": ["device_inventory"],
    "vm-image-list-v1": ["device_image_list"],
    "vm-image-import-v1": ["device_image_import"],
    "vm-operation-v1": ["device_disk_materialize", "device_reboot", "device_workspace_sync", "device_artifacts_export", "device_guest_agent_status", "device_guest_agent_provision"],
    "vm-target-list-v1": ["device_target_list"],
    "vm-readiness-v1": ["device_readiness_probe"],
    "vm-session-v1": ["device_session_open"],
    "wireless-status-v1": ["device_wireless"],
    "display-target-v1": ["display_current"],
    "image-content-v1": ["display_screenshot", "device_screenshot", "mobile_screenshot"],
    "pointer-action-v1": ["display_click", "display_double_click", "device_click", "device_double_click", "mobile_tap", "mobile_double_tap", "mobile_long_press", "mobile_swipe", "mobile_drag"],
    "key-action-v1": ["display_key", "device_key", "mobile_key", "mobile_home", "mobile_back", "mobile_forward", "mobile_recents", "mobile_power", "mobile_lock", "mobile_unlock"],
    "text-action-v1": ["display_type", "device_type", "mobile_type_text"],
    "scroll-action-v1": ["display_scroll", "device_scroll"],
    "cursor-position-v1": ["display_cursor_position", "device_cursor_position"],
    "lifecycle-device-v1": ["device_create", "device_start", "device_stop", "device_status"],
    "physical-attach-v1": ["device_attach"],
    "physical-detach-v1": ["device_detach"],
    "lifecycle-delete-v1": ["device_delete"],
    "command-execution-v1": ["device_exec"],
    "window-list-v1": ["device_window_list"],
    "accessibility-snapshot-v1": ["device_accessibility_snapshot"],
    "base-image-device-v1": ["device_base_image_create", "device_base_image_clone"],
    "snapshot-create-v1": ["device_snapshot_create"],
    "snapshot-list-v1": ["device_snapshot_list"],
    "snapshot-restore-v1": ["device_snapshot_restore"],
    "snapshot-delete-v1": ["device_snapshot_delete"],
    "recording-start-v1": ["device_record_video_start"],
    "recording-stop-v1": ["device_record_video_stop"],
    "recording-status-v1": ["device_record_video_status"],
    "file-upload-v1": ["device_upload"],
    "file-download-v1": ["device_download"],
    "device-reset-v1": ["device_reset"],
    "app-install-v1": ["device_install_app", "mobile_install_app"],
    "app-launch-v1": ["device_launch_app", "mobile_launch_app"],
    "mobile-session-status-v1": ["mobile_session_status"],
    "ui-hierarchy-v1": ["mobile_dump_ui"],
    "orientation-v1": ["mobile_rotate_left", "mobile_rotate_right", "mobile_set_orientation"],
    "url-open-v1": ["mobile_open_url"],
    "app-uninstall-v1": ["mobile_uninstall_app"],
    "app-stop-v1": ["mobile_stop_app"],
    "app-data-clear-v1": ["mobile_clear_app_data"],
    "permission-v1": ["mobile_grant_permission", "mobile_revoke_permission"],
    "location-v1": ["mobile_set_location"],
    "battery-v1": ["mobile_set_battery"],
    "network-v1": ["mobile_set_network", "mobile_toggle_airplane_mode"],
    "clipboard-set-v1": ["mobile_set_clipboard"],
    "clipboard-get-v1": ["mobile_get_clipboard"],
    "wait-text-v1": ["mobile_wait_for_text"],
    "wait-app-v1": ["mobile_wait_for_app"],
    "flow-result-v1": ["mobile_run_flow", "device_run_flow"],
};

export const DEVICE_LAB_OUTPUT_CONTRACTS = Object.freeze(Object.fromEntries(
    Object.entries(contractGroups).flatMap(([contract, tools]) => tools.map((tool) => [tool, contract])),
));

const requiredFieldsByContract = {
    "device-list-v1": ["devices"],
    "vm-image-list-v1": ["images"],
    "vm-image-import-v1": ["image"],
    "vm-target-list-v1": ["targets"],
    "vm-readiness-v1": ["readiness"],
    "vm-session-v1": ["session"],
    "display-target-v1": ["id"],
    "cursor-position-v1": ["x", "y"],
    "lifecycle-device-v1": ["device"],
    "physical-attach-v1": ["device"],
    "physical-detach-v1": ["detached"],
    "lifecycle-delete-v1": ["deleted"],
    "base-image-device-v1": ["device"],
    "snapshot-create-v1": ["snapshot"],
    "snapshot-list-v1": ["snapshots"],
    "snapshot-restore-v1": ["device"],
    "snapshot-delete-v1": ["deleted"],
    "recording-start-v1": ["recording"],
    "recording-status-v1": ["recording"],
    "file-upload-v1": ["uploaded"],
    "file-download-v1": ["downloaded"],
    "mobile-session-status-v1": ["deviceId"],
    "ui-hierarchy-v1": ["source"],
    "app-stop-v1": ["stopped"],
    "location-v1": ["location"],
    "clipboard-get-v1": ["text"],
    "flow-result-v1": ["results"],
};

const deviceObjectContracts = new Set(["lifecycle-device-v1", "physical-attach-v1", "base-image-device-v1", "snapshot-restore-v1"]);
const arrayFields = new Set(["devices", "images", "results", "targets"]);

export function validateDeviceLabToolOutput(tool, payload) {
    const contract = DEVICE_LAB_OUTPUT_CONTRACTS[tool];
    if (!contract) throw new Error(`No output contract registered for ${tool}`);
    if (contract === "image-content-v1") {
        if (payload?.content && Array.isArray(payload.content) && payload.content.some((item) => item?.type === "image")) return payload;
        throw contractError(tool, "required MCP image content is missing", payload);
    }
    const value = objectValue(payload);
    if (!value) throw contractError(tool, "expected an object", payload);
    if (value.ok === false) {
        const command = value.result?.execution?.command || value.selected?.body?.result?.execution?.command;
        const providerDetail = command?.error || command?.stderr || command?.stdout;
        const detail = providerDetail ? `: ${String(providerDetail).trim().slice(-512)}` : "";
        throw contractError(tool, `operation failed (${String(value.error || "unknown-error")})${detail}`, payload);
    }
    for (const field of requiredFieldsByContract[contract] || []) {
        if (!(field in value)) throw contractError(tool, `required ${field} field is missing`, payload);
        if (arrayFields.has(field) && !Array.isArray(value[field])) throw contractError(tool, `required ${field} array is invalid`, payload);
        if (field === "deviceId" && (typeof value[field] !== "string" || !value[field])) throw contractError(tool, "required deviceId string is missing", payload);
    }
    if (deviceObjectContracts.has(contract)) {
        const device = objectValue(value.device);
        if (!device) throw contractError(tool, "required device object is missing", payload);
        if (typeof device.id !== "string" || !device.id) throw contractError(tool, "required device.id string is missing", payload);
    }
    return value;
}

export function hasDeviceLabOutputContract(tool) {
    return Object.hasOwn(DEVICE_LAB_OUTPUT_CONTRACTS, tool);
}
