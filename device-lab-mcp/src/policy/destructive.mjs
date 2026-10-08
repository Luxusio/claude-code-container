export { evaluateDestructivePolicy } from "@ccc/device-lab/providers/domain/destructive-admission.mjs";

export const DESTRUCTIVE_POLICY_SCHEMA_EXAMPLES = [
    { name: "device_delete", args: { deviceId: "policy-device" } },
    { name: "device_delete", args: { force: true } },
    { name: "device_delete", args: { deleteAvd: true } },
    { name: "device_delete", args: { deleteSimulator: true } },
    { name: "device_reset", args: { deviceId: "policy-device", packageName: "com.example" } },
    { name: "device_snapshot_restore", args: { deviceId: "policy-device", snapshotName: "before-test" } },
    { name: "device_snapshot_delete", args: { deviceId: "policy-device", snapshotName: "before-test" } },
    { name: "device_broker_shutdown", args: {} },
    { name: "device_broker_command", args: { action: "invoke", command: "device_delete" } },
    { name: "device_broker_appium", args: { action: "request", method: "POST", path: "/appium/device/remove_app", body: { appId: "com.example" } } },
    { name: "mobile_uninstall_app", args: { deviceId: "policy-device", packageName: "com.example" } },
    { name: "mobile_clear_app_data", args: { deviceId: "policy-device", packageName: "com.example" } },
    { name: "mobile_set_battery", args: { deviceId: "policy-device", level: 50 } },
    { name: "mobile_set_network", args: { deviceId: "policy-device", wifi: true } },
    { name: "mobile_toggle_airplane_mode", args: { deviceId: "policy-device", enabled: false } },
];
