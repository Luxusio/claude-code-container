export type DeviceBackend = "android-emulator" | "android-device" | "ios-simulator" | "ios-device" | "windows-sandbox" | "macos-vm";
export type ObjectOutput = Record<string, unknown>;
export interface DeviceRecord {
    id: string;
    backend?: DeviceBackend;
    status?: string;
    provider?: string;
    providerInstance?: string;
    udid?: string;
    runtime?: ObjectOutput;
    helper?: { ssh?: { host?: string; user?: string; [key: string]: unknown }; [key: string]: unknown };
    [key: string]: unknown;
}
export interface LifecycleOutput {
    device: DeviceRecord;
    routedBy?: string;
    boot?: { ready?: boolean; ip?: string; error?: string; stderr?: string; [key: string]: unknown };
    helper?: { status?: string; [key: string]: unknown };
    alreadyAttached?: boolean;
    physicalDevicePoweredOff?: boolean;
    hostDevice?: unknown;
}
export interface DeleteOutput { deleted: string; routedBy?: string; providerDeleted?: string[] }
export interface MobileSessionStatusOutput {
    deviceId: string;
    backend?: DeviceBackend;
    session?: unknown;
    routedBy?: string;
    provider?: string;
    automationName?: string;
    lazy?: boolean;
    appium?: unknown;
}
export interface DeviceListOutput { devices: DeviceRecord[] }
export interface FlowOutput { results: ObjectOutput[] }
export interface ImageToolResult { content: Array<{ type: string; data?: string; mimeType?: string; [key: string]: unknown }>; isError?: boolean }

export interface DeviceLabToolOutputMap {
    device_backends: ObjectOutput; device_broker_status: ObjectOutput; device_list: DeviceListOutput; device_inventory: ObjectOutput; device_wireless: ObjectOutput;
    display_current: DeviceRecord; display_screenshot: ImageToolResult; display_click: ObjectOutput; display_double_click: ObjectOutput; display_key: ObjectOutput; display_type: ObjectOutput; display_scroll: ObjectOutput; display_cursor_position: ObjectOutput;
    device_create: LifecycleOutput; device_attach: LifecycleOutput; device_detach: ObjectOutput; device_delete: DeleteOutput; device_start: LifecycleOutput; device_stop: LifecycleOutput; device_status: LifecycleOutput;
    device_exec: ObjectOutput; device_screenshot: ImageToolResult; device_click: ObjectOutput; device_double_click: ObjectOutput; device_key: ObjectOutput; device_type: ObjectOutput; device_scroll: ObjectOutput; device_cursor_position: ObjectOutput; device_window_list: ObjectOutput; device_accessibility_snapshot: ObjectOutput;
    device_base_image_create: LifecycleOutput; device_base_image_clone: LifecycleOutput; device_snapshot_create: ObjectOutput; device_snapshot_restore: LifecycleOutput; device_snapshot_delete: DeleteOutput;
    device_record_video_start: ObjectOutput; device_record_video_stop: ObjectOutput; device_record_video_status: ObjectOutput; device_upload: ObjectOutput; device_download: ObjectOutput; device_reset: ObjectOutput; device_install_app: ObjectOutput; device_launch_app: ObjectOutput;
    mobile_session_status: MobileSessionStatusOutput; mobile_dump_ui: ObjectOutput; mobile_tap: ObjectOutput; mobile_double_tap: ObjectOutput; mobile_long_press: ObjectOutput; mobile_swipe: ObjectOutput; mobile_drag: ObjectOutput; mobile_type_text: ObjectOutput; mobile_key: ObjectOutput; mobile_home: ObjectOutput; mobile_back: ObjectOutput; mobile_forward: ObjectOutput; mobile_recents: ObjectOutput; mobile_power: ObjectOutput; mobile_lock: ObjectOutput; mobile_unlock: ObjectOutput; mobile_rotate_left: ObjectOutput; mobile_rotate_right: ObjectOutput; mobile_set_orientation: ObjectOutput; mobile_open_url: ObjectOutput;
    mobile_install_app: ObjectOutput; mobile_launch_app: ObjectOutput; mobile_uninstall_app: ObjectOutput; mobile_stop_app: ObjectOutput; mobile_clear_app_data: ObjectOutput; mobile_grant_permission: ObjectOutput; mobile_revoke_permission: ObjectOutput; mobile_set_location: ObjectOutput; mobile_set_battery: ObjectOutput; mobile_set_network: ObjectOutput; mobile_toggle_airplane_mode: ObjectOutput; mobile_set_clipboard: ObjectOutput; mobile_get_clipboard: ObjectOutput; mobile_wait_for_text: ObjectOutput; mobile_wait_for_app: ObjectOutput; mobile_screenshot: ImageToolResult; mobile_run_flow: FlowOutput; device_run_flow: FlowOutput;
}

export const DEVICE_LAB_OUTPUT_CONTRACTS: Readonly<Record<keyof DeviceLabToolOutputMap, string>>;
export function validateDeviceLabToolOutput<K extends keyof DeviceLabToolOutputMap>(tool: K, payload: unknown): DeviceLabToolOutputMap[K];
export function hasDeviceLabOutputContract(tool: string): tool is keyof DeviceLabToolOutputMap;
