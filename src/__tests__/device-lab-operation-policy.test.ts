import { describe, expect, it } from "vitest";
import {
    ownerDeviceOperationTools,
    requiresOwnerDeviceOperation,
} from "../../device-lab-mcp/src/state/device-operation-policy.mjs";

describe("direct device operation policy", () => {
    it.each([
        ["android", ["device_exec", "device_install_app", "device_download", "mobile_tap", "mobile_set_clipboard"]],
        ["android-device", ["device_attach", "device_upload", "mobile_clear_app_data"]],
        ["ios", ["device_reset", "mobile_dump_ui", "mobile_set_orientation"]],
        ["ios-device", ["device_install_app", "mobile_tap", "mobile_stop_app"]],
        ["windows", ["device_exec", "device_screenshot", "device_type", "device_download"]],
        ["macos", ["device_base_image_create", "device_snapshot_restore", "device_exec", "device_accessibility_snapshot"]],
    ])("serializes finite %s operations", (backend, tools) => {
        for (const tool of tools) expect(requiresOwnerDeviceOperation(backend, tool), tool).toBe(true);
        expect(new Set(ownerDeviceOperationTools(backend)).size).toBe(ownerDeviceOperationTools(backend).length);
    });

    it.each(["android", "android-device", "ios", "ios-device", "windows", "macos"])(
        "keeps %s observation and bounded-wait tools outside the operation lock",
        (backend) => {
            for (const tool of ["device_inventory", "device_status", "device_record_video_status", "mobile_session_status", "mobile_wait_for_text", "mobile_wait_for_app"]) {
                expect(requiresOwnerDeviceOperation(backend, tool), tool).toBe(false);
            }
        },
    );
});
