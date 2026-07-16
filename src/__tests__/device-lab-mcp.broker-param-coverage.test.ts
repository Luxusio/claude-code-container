import { describe, expect, it } from "vitest";
import { BROKER_DEVICE_TOOL_PARAM_KEYS } from "../../device-lab-mcp/src/broker.mjs";
import { TOOLS } from "../../device-lab-mcp/src/tools.mjs";

const BROKER_DEVICE_TOOL_ROUTABLE_TOOLS = new Set([
    "device_exec",
    "device_screenshot",
    "device_click",
    "device_double_click",
    "device_key",
    "device_type",
    "device_scroll",
    "device_cursor_position",
    "device_window_list",
    "device_accessibility_snapshot",
    "device_record_video_start",
    "device_record_video_stop",
    "device_record_video_status",
    "device_upload",
    "device_download",
    "device_reset",
    "device_install_app",
    "device_launch_app",
    "mobile_session_status",
    "mobile_dump_ui",
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
    "mobile_get_clipboard",
    "mobile_wait_for_text",
    "mobile_wait_for_app",
    "mobile_screenshot",
]);

const BROKER_ROUTE_ONLY_PROPERTIES = new Set([
    "broker",
    "viaBroker",
    "implicitBroker",
    "autolaunch",
    "hostCandidates",
    "launchHost",
    "port",
    "brokerPort",
    "rpcTimeoutMs",
    "launchTimeoutMs",
]);

describe("device-lab broker device tool param coverage", () => {
    it("keeps broker device tool forwarded params in lockstep with routed tool schemas", () => {
        expect(new Set(BROKER_DEVICE_TOOL_PARAM_KEYS).size).toBe(BROKER_DEVICE_TOOL_PARAM_KEYS.length);

        const forwarded = new Set(BROKER_DEVICE_TOOL_PARAM_KEYS);
        const missingByTool = TOOLS
            .filter((tool) => BROKER_DEVICE_TOOL_ROUTABLE_TOOLS.has(tool.name))
            .map((tool) => {
                const missing = Object.keys(tool.inputSchema?.properties || {})
                    .filter((property) => !BROKER_ROUTE_ONLY_PROPERTIES.has(property))
                    .filter((property) => !forwarded.has(property))
                    .sort();
                return { name: tool.name, missing };
            })
            .filter((item) => item.missing.length > 0);

        expect(missingByTool).toEqual([]);
    });
});
