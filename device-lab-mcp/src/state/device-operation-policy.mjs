const COMMON_MOBILE_MUTATIONS = [
    "mobile_tap",
    "mobile_double_tap",
    "mobile_long_press",
    "mobile_swipe",
    "mobile_drag",
    "mobile_type_text",
    "mobile_key",
    "mobile_home",
    "mobile_back",
    "mobile_forward",
    "mobile_recents",
    "mobile_power",
    "mobile_lock",
    "mobile_unlock",
    "mobile_rotate_left",
    "mobile_rotate_right",
    "mobile_set_orientation",
    "mobile_open_url",
    "mobile_install_app",
    "mobile_launch_app",
    "mobile_uninstall_app",
    "mobile_stop_app",
    "mobile_clear_app_data",
    "mobile_grant_permission",
    "mobile_revoke_permission",
    "mobile_set_location",
    "mobile_set_battery",
    "mobile_set_network",
    "mobile_toggle_airplane_mode",
    "mobile_set_clipboard",
];

const OPERATION_TOOLS = new Map([
    ["android", new Set([
        "device_create", "device_delete", "device_start", "device_stop",
        "device_exec", "device_screenshot", "device_record_video_start", "device_record_video_stop",
        "device_upload", "device_download", "device_install_app", "device_launch_app", "device_reset",
        "mobile_dump_ui", "mobile_get_clipboard", "mobile_screenshot",
        ...COMMON_MOBILE_MUTATIONS,
    ])],
    ["android-device", new Set([
        "device_attach", "device_detach", "device_start", "device_stop",
        "device_exec", "device_screenshot", "device_record_video_start", "device_record_video_stop",
        "device_upload", "device_download", "device_install_app", "device_launch_app", "device_reset",
        "mobile_dump_ui", "mobile_get_clipboard", "mobile_screenshot",
        ...COMMON_MOBILE_MUTATIONS,
    ])],
    ["ios", new Set([
        "device_create", "device_delete", "device_start", "device_stop",
        "device_exec", "device_screenshot", "device_record_video_start", "device_record_video_stop",
        "device_upload", "device_download", "device_install_app", "device_launch_app", "device_reset",
        "mobile_dump_ui", "mobile_get_clipboard", "mobile_screenshot",
        ...COMMON_MOBILE_MUTATIONS,
    ])],
    ["ios-device", new Set([
        "device_attach", "device_detach", "device_start", "device_stop",
        "device_exec", "device_screenshot", "device_install_app", "device_launch_app",
        "mobile_dump_ui", "mobile_screenshot",
        ...COMMON_MOBILE_MUTATIONS,
    ])],
    ["windows", new Set([
        "device_create", "device_delete", "device_start", "device_stop",
        "device_exec", "device_screenshot", "device_click", "device_double_click",
        "device_key", "device_type", "device_scroll", "device_cursor_position",
        "device_window_list", "device_accessibility_snapshot",
        "device_record_video_start", "device_record_video_stop", "device_upload", "device_download",
    ])],
    ["windows-vm", new Set([
        "device_create", "device_delete", "device_start", "device_stop", "device_reboot",
        "device_exec", "device_upload", "device_download",
        "device_snapshot_list", "device_snapshot_create", "device_snapshot_restore", "device_snapshot_delete",
    ])],
    ["linux-vm", new Set([
        "device_create", "device_delete", "device_start", "device_stop", "device_reboot",
        "device_exec", "device_upload", "device_download",
        "device_snapshot_list", "device_snapshot_create", "device_snapshot_restore", "device_snapshot_delete",
    ])],
    ["macos", new Set([
        "device_base_image_create", "device_base_image_clone",
        "device_create", "device_delete", "device_start", "device_stop",
        "device_snapshot_create", "device_snapshot_restore", "device_snapshot_delete",
        "device_exec", "device_upload", "device_download", "device_screenshot",
        "device_click", "device_double_click", "device_key", "device_type", "device_scroll",
        "device_cursor_position", "device_window_list", "device_accessibility_snapshot",
        "device_record_video_start", "device_record_video_stop",
    ])],
]);

export function requiresOwnerDeviceOperation(backend, tool) {
    return OPERATION_TOOLS.get(backend)?.has(tool) === true;
}

export function ownerDeviceOperationTools(backend) {
    return [...(OPERATION_TOOLS.get(backend) || [])];
}
