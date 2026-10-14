const HELPER_TIMEOUT_PROPERTY = { type: "number", minimum: 1, maximum: 300000 };
const BOUNDED_WAIT_TIMEOUT_PROPERTY = { type: "number", minimum: 1, maximum: 600000 };
const HYPER_V_BOOT_TIMEOUT_PROPERTY = { type: "number", minimum: 1, maximum: 1200000, description: "Maximum guest boot and transport wait in milliseconds. Hyper-V linux-vm GUI installation has a separate bounded first-start budget." };
const BOUNDED_WAIT_INTERVAL_PROPERTY = { type: "number", minimum: 1, maximum: 60000 };
const DEVICE_ID_PROPERTY = {
    type: "string",
    minLength: 1,
    maxLength: 128,
    pattern: "^(?!\\.\\.?$)[A-Za-z0-9._-]+$",
};
const DEVICE_PATH_PROPERTY = { type: "string", maxLength: 4096 };
const LINUX_VM_BACKEND_PROPERTY = { backend: { type: "string", enum: ["linux-vm"] } };
const REBOOT_VM_BACKEND_PROPERTY = { backend: { type: "string", enum: ["windows-vm", "linux-vm"] } };
const BOUNDED_FILE_POLICY_PROPERTIES = {
    maxFiles: { type: "number", minimum: 1, maximum: 5000 },
    maxFileBytes: { type: "number", minimum: 1, maximum: 16777216 },
    maxTotalBytes: { type: "number", minimum: 1, maximum: 268435456 },
};
const DEVICE_UPLOAD_FILE_POLICY_PROPERTIES = {
    ...BOUNDED_FILE_POLICY_PROPERTIES,
    maxFileBytes: { type: "number", minimum: 1, maximum: 134217728 },
};

const DEVICE_BACKEND_PROPERTY = {
    backend: { type: "string", enum: ["android-emulator", "android-device", "ios-simulator", "ios-device", "windows-sandbox", "windows-vm", "macos-vm", "linux-vm"] },
};

const DEVICE_WITH_DISPLAY_BACKEND_PROPERTY = {
    backend: { type: "string", enum: ["x11-current-display", "android-emulator", "android-device", "ios-simulator", "ios-device", "windows-sandbox", "windows-vm", "macos-vm", "linux-vm"] },
};

const DEVICE_STATUS_BACKEND_PROPERTY = {
    backend: { type: "string", enum: ["x11-current-display", "android-emulator", "android-device", "ios-simulator", "ios-device", "windows-sandbox", "windows-vm", "macos-vm", "linux-vm"] },
};

const DEVICE_DELETE_BACKEND_PROPERTY = {
    backend: { type: "string", enum: ["android-emulator", "ios-simulator", "windows-sandbox", "windows-vm", "macos-vm", "linux-vm"] },
};

const DEVICE_EXEC_BACKEND_PROPERTY = {
    backend: { type: "string", enum: ["android-emulator", "android-device", "ios-simulator", "windows-sandbox", "windows-vm", "macos-vm", "linux-vm"] },
};

const MOBILE_BACKEND_PROPERTY = {
    backend: { type: "string", enum: ["android-emulator", "android-device", "ios-simulator", "ios-device"] },
};

const ANDROID_BACKEND_PROPERTY = {
    backend: { type: "string", enum: ["android-emulator", "android-device"] },
};

const ANDROID_EMULATOR_BACKEND_PROPERTY = {
    backend: { type: "string", enum: ["android-emulator"] },
};

const PHYSICAL_BACKEND_PROPERTY = {
    backend: { type: "string", enum: ["android-device", "ios-device"] },
};

const DESKTOP_BACKEND_PROPERTY = {
    backend: { type: "string", enum: ["windows-sandbox", "macos-vm"] },
};

const DISPLAY_DESKTOP_BACKEND_PROPERTY = {
    backend: { type: "string", enum: ["x11-current-display", "windows-sandbox", "windows-vm", "macos-vm", "linux-vm"] },
};

const SNAPSHOT_BACKEND_PROPERTY = {
    backend: { type: "string", enum: ["windows-vm", "macos-vm", "linux-vm"] },
};
const SNAPSHOT_LIST_BACKEND_PROPERTY = {
    backend: { type: "string", enum: ["windows-vm", "linux-vm"] },
};

const RECORDING_BACKEND_PROPERTY = {
    backend: { type: "string", enum: ["android-emulator", "android-device", "ios-simulator", "windows-sandbox", "macos-vm"] },
};

const FILE_TRANSFER_BACKEND_PROPERTY = {
    backend: { type: "string", enum: ["android-emulator", "android-device", "ios-simulator", "windows-sandbox", "windows-vm", "macos-vm", "linux-vm"] },
};

const RESET_BACKEND_PROPERTY = {
    backend: { type: "string", enum: ["android-emulator", "android-device", "ios-simulator"] },
};

const EMULATOR_SIMULATOR_BACKEND_PROPERTY = {
    backend: { type: "string", enum: ["android-emulator", "ios-simulator"] },
};

const MOBILE_WITHOUT_IOS_DEVICE_BACKEND_PROPERTY = {
    backend: { type: "string", enum: ["android-emulator", "android-device", "ios-simulator"] },
};

const APP_BACKEND_PROPERTY = {
    backend: { type: "string", enum: ["android-emulator", "android-device", "ios-simulator", "ios-device"] },
};

const DEVICE_BROKER_ROUTE_PROPERTIES = {
    ...DEVICE_BACKEND_PROPERTY,
};


const CONFIRM_DESTRUCTIVE_PROPERTY = {
    confirmDestructive: { type: "boolean", const: true, description: "Required true to authorize this destructive operation." },
};

function mobileBrokerProperties(properties) {
    return { ...properties, ...MOBILE_BACKEND_PROPERTY };
}

function deviceBrokerProperties(properties) {
    return { ...properties, ...DEVICE_BROKER_ROUTE_PROPERTIES };
}

function typedDeviceBrokerProperties(backendProperty, properties) {
    return { ...properties, ...backendProperty };
}

function typedMobileBrokerProperties(backendProperty, properties) {
    return { ...properties, ...backendProperty };
}

const APP_LAUNCH_ANY_OF = [{ required: ["packageName"] }, { required: ["bundleId"] }, { required: ["component"] }];
const APP_ID_ANY_OF = [{ required: ["packageName"] }, { required: ["bundleId"] }];
const APP_PERMISSION_ANY_OF = [{ required: ["packageName", "permission"] }, { required: ["bundleId", "service"] }];
const SNAPSHOT_ID_ANY_OF = [{ required: ["snapshotName"] }, { required: ["snapshotId"] }];
const RESET_TARGET_ANY_OF = [{ required: ["packageName"] }, { required: ["bundleId"] }, { required: ["eraseSimulator"] }];
const BATTERY_CONTROL_ANY_OF = [{ required: ["level"] }, { required: ["status"] }, { required: ["charging"] }];
const NETWORK_CONTROL_ANY_OF = [{ required: ["wifi"] }, { required: ["data"] }];

export const DEVICE_FLOW_TOOL_NAMES = [
    "device_list_files",
    "device_inventory",
    "device_record_video_status",
    "device_status",
    "device_screenshot",
    "device_click",
    "device_double_click",
    "device_key",
    "device_type",
    "device_scroll",
    "device_cursor_position",
    "device_window_list",
    "device_focus_window",
    "device_drag",
    "device_accessibility_snapshot",
    "display_current",
    "display_screenshot",
    "display_click",
    "display_double_click",
    "display_key",
    "display_type",
    "display_scroll",
    "display_cursor_position",
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
    "mobile_set_orientation",
    "mobile_open_url",
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
];

const RUN_FLOW_INPUT_SCHEMA = {
    type: "object",
    properties: {
        deviceId: { ...DEVICE_ID_PROPERTY, description: "Shared target for device steps. Changing a step deviceId or backend clears inherited target fields." },
        ...DEVICE_WITH_DISPLAY_BACKEND_PROPERTY,
        stopOnError: { type: "boolean", description: "Stop after the first rejected or failing step; defaults to true." },
        steps: {
            type: "array",
            minItems: 1,
            maxItems: 50,
            description: "Ordered MCP tool steps to dispatch. Each step names a permitted tool and passes that tool's normal arguments.",
            items: {
                type: "object",
                properties: {
                    tool: { type: "string", enum: DEVICE_FLOW_TOOL_NAMES },
                    label: { type: "string", description: "Optional label copied into the flow result." },
                    arguments: { type: "object", description: "Arguments forwarded to the selected tool." },
                },
                required: ["tool"],
            },
        },
    },
    required: ["steps"],
};

const DEVICE_BASE_IMAGE_CREATE_INPUT_SCHEMA = {
    type: "object",
    properties: {
        backend: { type: "string", enum: ["macos-vm"] },
        name: { type: "string" },
        deviceId: DEVICE_ID_PROPERTY,
        provider: { type: "string" },
        sourceImage: { type: "string" },
        memoryMb: { type: "integer" },
        cpus: { type: "integer" },
        sshHost: { type: "string" },
        sshPort: { type: "number" },
        sshUser: { type: "string" },
        sshKeyPath: { type: "string" },
        sshPassword: { type: "string" },
    },
    required: ["backend", "name", "sourceImage"],
};

const DEVICE_BASE_IMAGE_CLONE_INPUT_SCHEMA = {
    type: "object",
    properties: {
        backend: { type: "string", enum: ["macos-vm"] },
        name: { type: "string" },
        deviceId: DEVICE_ID_PROPERTY,
        sourceDeviceId: { type: "string" },
        sourceImage: { type: "string" },
        provider: { type: "string" },
        memoryMb: { type: "integer" },
        cpus: { type: "integer" },
        sshHost: { type: "string" },
        sshPort: { type: "number" },
        sshUser: { type: "string" },
        sshKeyPath: { type: "string" },
        sshPassword: { type: "string" },
        force: { type: "boolean" },
    },
    required: ["backend", "name"],
};

const DEVICE_CREATE_INPUT_SCHEMA = {
    type: "object",
    properties: {
        backend: { type: "string", enum: ["android-emulator", "ios-simulator", "windows-sandbox", "windows-vm", "macos-vm", "linux-vm"] },
        name: { type: "string" },
        deviceId: DEVICE_ID_PROPERTY,
        headless: { type: "boolean" },
        minimized: { type: "boolean" },
        provider: { type: "string", enum: ["auto", "hyper-v", "tart", "vz", "utmctl", "container-qemu"] },
        image: { type: "string", description: "Hyper-V image identifier/path; macOS image reference for SSH defaults." },
        sourceImage: { type: "string", description: "Hyper-V base image path or container-QEMU source; QEMU alternative to baseImageId." },
        profile: { type: "string", enum: ["windows-11", "windows-server", "ubuntu-lts", "linux"] },
        switchName: { type: "string", maxLength: 128 },
        secureBootTemplate: { type: "string", enum: ["MicrosoftWindows", "MicrosoftUEFICertificateAuthority"] },
        baseImageId: DEVICE_ID_PROPERTY,
        memoryMb: { type: "integer", description: "Memory in MiB.", minimum: 1024, maximum: 131072 },
        cpus: { type: "integer", description: "Virtual CPU count.", minimum: 1, maximum: 64 },
        nestedVirtualization: { type: "boolean", description: "Allow this VM to run nested VMs. Defaults to false." },
        sshHost: { type: "string" },
        sshPort: { type: "number" },
        sshUser: { type: "string" },
        sshKeyPath: { type: "string" },
        sshPassword: { type: "string" },
        guestSshHost: { type: "string", maxLength: 255 },
        guestSshPort: { type: "number", minimum: 1, maximum: 65535 },
        guestSshUser: { type: "string", maxLength: 64 },
        guestSshKeyPath: DEVICE_PATH_PROPERTY,
        guestReadinessCommand: { type: "string", maxLength: 512 },
        guestAgentName: { type: "string", maxLength: 64 },
        guestAgentHealthCommand: { type: "string", maxLength: 512 },
        guestAgentProvisionCommand: { type: "string", maxLength: 4096 },
        guestAgentAutoProvision: { type: "boolean" },
        force: { type: "boolean" },
        simulatorName: { type: "string" },
        deviceType: { type: "string" },
        runtime: { type: "string" },
        udid: { type: "string" },
        createSimulator: { type: "boolean", description: "iOS: create a simulator now; default false only records a definition." },
        avdName: { type: "string" },
        systemImage: { type: "string", description: "Android SDK system-images package ID; required with createAvd." },
        deviceProfile: { type: "string" },
        createAvd: { type: "boolean", description: "Android: provision the AVD now; default false only records a definition." },
        port: { type: "integer", minimum: 1, maximum: 65535 },
        dryRun: { type: "boolean" },
        networking: { type: "boolean" },
        clipboard: { type: "boolean" },
        vgpu: { type: "boolean" },
    },
    required: ["backend", "name"],
};

export const SINGLE_BACKEND_TOOL_DEFAULTS = Object.freeze({
    device_image_list: "linux-vm",
    device_image_import: "linux-vm",
    device_target_list: "linux-vm",
    device_readiness_probe: "linux-vm",
    device_session_open: "linux-vm",
    device_workspace_sync: "linux-vm",
    device_artifacts_export: "linux-vm",
    device_guest_agent_status: "linux-vm",
    device_guest_agent_provision: "linux-vm",
    device_base_image_create: "macos-vm",
    device_base_image_clone: "macos-vm",
});


export const TOOLS = [
    {
        name: "device_list_files",
        description: "List immediate device directory entries, including hidden files, without recursion. Returns names, types and available file sizes; truncated means the entry or byte bound was reached. iOS Simulator requires bundleId and an app-container-relative path (use / for its root). Current-display and physical iOS adapters do not support listing.",
        inputSchema: {
            type: "object",
            properties: {
                deviceId: DEVICE_ID_PROPERTY,
                path: { type: "string", minLength: 1, maxLength: 4096 },
                limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
                bundleId: { type: "string", minLength: 1, maxLength: 255, description: "Required for iOS Simulator app-container listing." },
                containerType: { type: "string", enum: ["data", "app", "groups"], default: "data" },
            },
            required: ["deviceId", "path"],
        },
    },
    { name: "device_focus_window", description: "Activate a window by its handle from window_list. Supported on X11, Windows Sandbox, Hyper-V Windows/Linux and macOS windows with a returned handle. Mobile is unsupported. Windows Hyper-V requires the guest user at the console and timeoutMs >= 30000.", inputSchema: { type: "object", properties: { deviceId: DEVICE_ID_PROPERTY, handle: { type: "string", maxLength: 2048, pattern: "^(?:[1-9][0-9]{0,15}|macos:[1-9][0-9]{0,9}:[1-9][0-9]{0,15}:.+)$", description: "Copy the opaque handle from window_list unchanged." }, helperTimeoutMs: HELPER_TIMEOUT_PROPERTY }, required: ["deviceId", "handle"] } },
    { name: "device_backends", description: "Check backend prerequisites without starting devices; detail:true adds capabilities. Use device_list for owned IDs.", inputSchema: { type: "object", properties: {}, required: [] } },
    { name: "device_broker_status", description: "Inspect the zero-configuration host broker contract without starting devices", inputSchema: { type: "object", properties: { probe: { type: "boolean" } }, required: [] } },
    { name: "device_list", description: "Find owned device IDs and the current display. Use device_backends for prerequisites or device_inventory for host candidates.", inputSchema: { type: "object", properties: {}, required: [] } },
    { name: "device_inventory", description: "Inspect one backend’s owned devices and host candidates. Omit backend to aggregate provider inventories; specify backend to filter. Use device_list for all owned IDs.", inputSchema: { type: "object", properties: deviceBrokerProperties({ backend: { type: "string", enum: ["android-emulator", "android-device", "ios-simulator", "ios-device", "windows-sandbox", "windows-vm", "macos-vm", "linux-vm"] } }), required: [] } },
    { name: "device_image_list", description: "Container QEMU: list owner-scoped VM base images", inputSchema: { type: "object", properties: LINUX_VM_BACKEND_PROPERTY, required: ["backend"] } },
    { name: "device_image_import", description: "Container QEMU: import or register an owner-scoped VM base image", inputSchema: { type: "object", properties: { ...LINUX_VM_BACKEND_PROPERTY, name: { type: "string", maxLength: 128 }, imageId: DEVICE_ID_PROPERTY, sourcePath: DEVICE_PATH_PROPERTY, format: { type: "string", enum: ["qcow2", "raw"] }, copy: { type: "boolean" }, force: { type: "boolean" } }, required: ["backend", "name", "sourcePath"] } },
    { name: "device_wireless", description: "Prepare or inspect native real-device wireless debugging without creating an owner attachment", inputSchema: { type: "object", properties: { backend: { type: "string", enum: ["android-device", "ios-device"] }, action: { type: "string", enum: ["status", "usb-tcpip", "pair", "connect"] }, serial: { type: "string", minLength: 1 }, udid: { type: "string", minLength: 1 }, host: { type: "string", minLength: 1 }, port: { type: "integer", minimum: 1, maximum: 65535 }, pairHost: { type: "string", minLength: 1 }, pairPort: { type: "integer", minimum: 1, maximum: 65535 }, pairingCode: { type: "string", minLength: 1 }, connect: { type: "boolean" }, timeoutMs: { type: "number", minimum: 1, maximum: 30000 } }, required: ["backend"] } },
    { name: "display_current", description: "Return the current non-creatable display target for this CCC container", inputSchema: { type: "object", properties: {}, required: [] } },
    { name: "display_screenshot", description: "Take a screenshot of the current CCC X11 display", inputSchema: { type: "object", properties: {}, required: [] } },
    { name: "display_click", description: "Click at coordinates on the current CCC X11 display", inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, button: { type: "string", enum: ["left", "right"] } }, required: ["x", "y"] } },
    { name: "display_double_click", description: "Double-click at coordinates on the current CCC X11 display", inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, button: { type: "string", enum: ["left", "right"] } }, required: ["x", "y"] } },
    { name: "display_key", description: "Send a key or key combination to the current CCC X11 display using xdotool syntax", inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } },
    { name: "display_type", description: "Type text into the current CCC X11 display", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
    { name: "display_scroll", description: "Scroll at coordinates on the current CCC X11 display", inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, direction: { type: "string", enum: ["up", "down", "left", "right"] }, amount: { type: "number" } }, required: ["x", "y", "direction"] } },
    { name: "display_cursor_position", description: "Get the current mouse cursor position on the CCC X11 display", inputSchema: { type: "object", properties: {}, required: [] } },
    { name: "device_create", description: "Define a device, then device_start to boot. Android: AVD fields; iOS: simulator fields; Hyper-V: image/profile/switch; macOS: image/ssh*; container QEMU: baseImageId/sourceImage and guest*. Physical devices use device_attach.", inputSchema: DEVICE_CREATE_INPUT_SCHEMA },
    { name: "device_attach", description: "Attach a host-connected physical device to this CCC owner scope", inputSchema: { type: "object", properties: { backend: { type: "string", enum: ["android-device", "ios-device"] }, name: { type: "string" }, deviceId: DEVICE_ID_PROPERTY, serial: { type: "string" }, udid: { type: "string" }, connection: { type: "string", enum: ["usb", "wifi"] }, host: { type: "string" }, port: { type: "integer", minimum: 1, maximum: 65535 } }, required: ["backend"] } },
    { name: "device_detach", description: "Detach an owner-scoped physical device without powering it off", inputSchema: { type: "object", properties: { ...PHYSICAL_BACKEND_PROPERTY, deviceId: DEVICE_ID_PROPERTY }, required: ["deviceId"] } },
    { name: "device_delete", description: "Delete an owner-scoped stopped device definition", inputSchema: { type: "object", properties: typedDeviceBrokerProperties(DEVICE_DELETE_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, force: { type: "boolean" }, preserveNetwork: { type: "boolean", description: "For Hyper-V only, release this device's exact allocation while retaining the verified shared managed switch, gateway, and NAT for reuse." }, deleteAvd: { type: "boolean", description: "Android emulator only: also delete the owned AVD. Defaults to false, retaining the AVD when its device definition is deleted." }, deleteSimulator: { type: "boolean", description: "iOS Simulator only: also delete the owned simulator. Defaults to false, retaining the simulator when its device definition is deleted." }, ...CONFIRM_DESTRUCTIVE_PROPERTY }), required: ["deviceId"] } },
    { name: "device_start", description: "Boot a created device. Physical devices activate the attachment and automation without powering on the phone. Hyper-V linux-vm installs its desktop on first boot; success means SSH and GUI are ready. Initial setup can take about 15 extra minutes.", inputSchema: { type: "object", properties: deviceBrokerProperties({ deviceId: DEVICE_ID_PROPERTY, waitForBoot: { type: "boolean", description: "Wait for boot readiness; false skips it where supported. linux-vm/windows-vm require true to finish bootstrap cleanup. Defaults to true. Success waits for the configured control transport; app readiness and desktop permissions are separate." }, bootTimeoutMs: HYPER_V_BOOT_TIMEOUT_PROPERTY, headless: { type: "boolean" }, minimized: { type: "boolean" } }), required: ["deviceId"] } },
    { name: "device_stop", description: "Stop an owner-scoped device instance. Physical devices detach automation without powering off the phone", inputSchema: { type: "object", properties: deviceBrokerProperties({ deviceId: DEVICE_ID_PROPERTY, force: { type: "boolean" } }), required: ["deviceId"] } },
    { name: "device_reboot", description: "Reboot an owner-scoped VM and wait for its guest transport to become ready", inputSchema: { type: "object", properties: typedDeviceBrokerProperties(REBOOT_VM_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, force: { type: "boolean" }, startIfStopped: { type: "boolean" }, waitForBoot: { type: "boolean", description: "Wait for boot readiness; false skips it where supported. linux-vm/windows-vm require true to finish bootstrap cleanup. Defaults to true. Success waits for the configured control transport; app readiness and desktop permissions are separate." }, bootTimeoutMs: HYPER_V_BOOT_TIMEOUT_PROPERTY }), required: ["deviceId"] } },
    { name: "device_status", description: "Inspect recorded device state and backend status; live readiness checks vary by backend.", inputSchema: { type: "object", properties: typedDeviceBrokerProperties(DEVICE_STATUS_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, }), required: ["deviceId"] } },
    { name: "device_disk_materialize", description: "Create or plan an owner-scoped writable VM overlay disk", inputSchema: { type: "object", properties: typedDeviceBrokerProperties(LINUX_VM_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, dryRun: { type: "boolean" }, force: { type: "boolean" } }), required: ["deviceId"] } },
    { name: "device_target_list", description: "Container QEMU: list VM targets and recorded readiness; use device_readiness_probe for a fresh check.", inputSchema: { type: "object", properties: typedDeviceBrokerProperties(LINUX_VM_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY }), required: ["backend"] } },
    { name: "device_readiness_probe", description: "Container QEMU: actively check and record readiness for a running VM target.", inputSchema: { type: "object", properties: typedDeviceBrokerProperties(LINUX_VM_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, targetId: DEVICE_ID_PROPERTY }), required: ["backend", "deviceId"] } },
    { name: "device_session_open", description: "Container QEMU: record an owner-scoped observable VM session without exposing host shell authority", inputSchema: { type: "object", properties: typedDeviceBrokerProperties(LINUX_VM_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, sessionId: DEVICE_ID_PROPERTY, targetId: DEVICE_ID_PROPERTY, sessionType: { type: "string", enum: ["monitor", "metadata", "guest-ssh", "guest-agent"] } }), required: ["backend", "deviceId"] } },
    { name: "device_workspace_sync", description: "Container QEMU: copy a bounded local workspace tree into owner-scoped VM state", inputSchema: { type: "object", properties: typedDeviceBrokerProperties(LINUX_VM_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, sourcePath: DEVICE_PATH_PROPERTY, replace: { type: "boolean" }, ...BOUNDED_FILE_POLICY_PROPERTIES }), required: ["backend", "deviceId"] } },
    { name: "device_artifacts_export", description: "Container QEMU: export bounded VM artifacts to an owner-scoped local directory", inputSchema: { type: "object", properties: typedDeviceBrokerProperties(LINUX_VM_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, sourcePath: DEVICE_PATH_PROPERTY, destinationPath: DEVICE_PATH_PROPERTY, replace: { type: "boolean" }, ...BOUNDED_FILE_POLICY_PROPERTIES }), required: ["backend", "deviceId"] } },
    { name: "device_guest_agent_status", description: "Container QEMU: probe bounded persistent guest-agent health metadata", inputSchema: { type: "object", properties: typedDeviceBrokerProperties(LINUX_VM_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, timeoutMs: BOUNDED_WAIT_TIMEOUT_PROPERTY }), required: ["backend", "deviceId"] } },
    { name: "device_guest_agent_provision", description: "Container QEMU: run configured bounded guest-agent provisioning and persist sanitized status", inputSchema: { type: "object", properties: typedDeviceBrokerProperties(LINUX_VM_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, timeoutMs: BOUNDED_WAIT_TIMEOUT_PROPERTY }), required: ["backend", "deviceId"] } },
    { name: "device_exec", description: "Run a command on an owner-scoped device", inputSchema: { type: "object", properties: typedDeviceBrokerProperties(DEVICE_EXEC_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, command: { type: "string", maxLength: 4096 }, timeoutMs: BOUNDED_WAIT_TIMEOUT_PROPERTY, helperTimeoutMs: HELPER_TIMEOUT_PROPERTY }), required: ["deviceId", "command"] } },
    { name: "device_screenshot", description: "Capture the owner device display as a PNG. For Hyper-V Windows/Linux VMs, use the returned width and height with the input tools; pixel (0,0) is the image's top-left.", inputSchema: { type: "object", properties: typedDeviceBrokerProperties(DEVICE_WITH_DISPLAY_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, helperTimeoutMs: HELPER_TIMEOUT_PROPERTY }), required: ["deviceId"] } },
    { name: "device_click", description: "Click at x,y on the latest device screenshot; (0,0) is its top-left.", inputSchema: { type: "object", properties: typedDeviceBrokerProperties(DISPLAY_DESKTOP_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, x: { type: "number", description: "Horizontal pixel in the latest screenshot, measured from the left edge." }, y: { type: "number", description: "Vertical pixel in the latest screenshot, measured from the top edge." }, button: { type: "string", enum: ["left", "right"], description: "Mouse button; defaults to left." }, helperTimeoutMs: HELPER_TIMEOUT_PROPERTY }), required: ["deviceId", "x", "y"] } },
    { name: "device_double_click", description: "Double-click at x,y on the latest device screenshot; (0,0) is its top-left.", inputSchema: { type: "object", properties: typedDeviceBrokerProperties(DISPLAY_DESKTOP_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, x: { type: "number", description: "Horizontal pixel in the latest screenshot, measured from the left edge." }, y: { type: "number", description: "Vertical pixel in the latest screenshot, measured from the top edge." }, button: { type: "string", enum: ["left", "right"], description: "Mouse button; defaults to left." }, helperTimeoutMs: HELPER_TIMEOUT_PROPERTY }), required: ["deviceId", "x", "y"] } },
    { name: "device_key", description: "Press a key or combination in the owner device display. Hyper-V examples: Enter, Escape, Tab, Backspace, Delete, Up, F1, Ctrl+C, Alt+Tab; separate combo keys with +.", inputSchema: { type: "object", properties: typedDeviceBrokerProperties(DISPLAY_DESKTOP_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, key: { type: "string", description: "Key or combination, e.g. Enter or Ctrl+C." }, helperTimeoutMs: HELPER_TIMEOUT_PROPERTY }), required: ["deviceId", "key"] } },
    { name: "device_type", description: "Type text (1-2048 characters) into the focused owner device display. Hyper-V linux-vm types through the guest X11 session; on Hyper-V windows-vm only ASCII text is verified, so send non-ASCII text through device_exec.", inputSchema: { type: "object", properties: typedDeviceBrokerProperties(DISPLAY_DESKTOP_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, text: { type: "string" }, helperTimeoutMs: HELPER_TIMEOUT_PROPERTY }), required: ["deviceId", "text"] } },
    { name: "device_scroll", description: "Scroll the owner display. Hyper-V Windows/Linux VMs support up/down at x,y from the latest screenshot; left/right is unavailable on Hyper-V. macOS scrolls at the current cursor.", inputSchema: { type: "object", properties: typedDeviceBrokerProperties(DISPLAY_DESKTOP_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, x: { type: "number", description: "Horizontal pixel in the latest screenshot when this backend needs a location." }, y: { type: "number", description: "Vertical pixel in the latest screenshot when this backend needs a location." }, direction: { type: "string", enum: ["up", "down", "left", "right"], description: "Hyper-V Windows/Linux VM console accepts up or down only." }, amount: { type: "number", description: "Scroll step count." }, helperTimeoutMs: HELPER_TIMEOUT_PROPERTY }), required: ["deviceId", "direction"] } },
    { name: "device_cursor_position", description: "Read the owner display's cursor position. On Hyper-V Windows/Linux VMs, provide both x and y to move the cursor to that pixel in the latest screenshot; omit both to query. Other backends only read the cursor and return device-cursor-move-backend-unsupported for x/y.", inputSchema: { type: "object", properties: typedDeviceBrokerProperties(DISPLAY_DESKTOP_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, x: { type: "integer", minimum: 0, description: "Optional horizontal screenshot pixel for Hyper-V cursor movement; requires y." }, y: { type: "integer", minimum: 0, description: "Optional vertical screenshot pixel for Hyper-V cursor movement; requires x." }, helperTimeoutMs: HELPER_TIMEOUT_PROPERTY }), required: ["deviceId"] } },
    { name: "device_window_list", description: "List visible desktop windows", inputSchema: { type: "object", properties: typedDeviceBrokerProperties(DESKTOP_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, helperTimeoutMs: HELPER_TIMEOUT_PROPERTY }), required: ["deviceId"] } },
    { name: "device_accessibility_snapshot", description: "Return a bounded desktop accessibility tree snapshot", inputSchema: { type: "object", properties: typedDeviceBrokerProperties(DESKTOP_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, maxDepth: { type: "number", minimum: 0, maximum: 8 }, maxNodes: { type: "number", minimum: 1, maximum: 1000 }, helperTimeoutMs: HELPER_TIMEOUT_PROPERTY }), required: ["deviceId"] } },
    { name: "device_base_image_create", description: "Create an owner-scoped macOS VM base-image clone from a provider image source", inputSchema: DEVICE_BASE_IMAGE_CREATE_INPUT_SCHEMA },
    { name: "device_base_image_clone", description: "Clone an owner-scoped macOS VM base-image/device definition from a provider source or owned device", inputSchema: DEVICE_BASE_IMAGE_CLONE_INPUT_SCHEMA },
    { name: "device_snapshot_list", description: "List owner-scoped Hyper-V VM snapshots", inputSchema: { type: "object", properties: typedDeviceBrokerProperties(SNAPSHOT_LIST_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, }), required: ["deviceId"] } },
    { name: "device_snapshot_create", description: "Create an owner-scoped VM snapshot", inputSchema: { type: "object", properties: typedDeviceBrokerProperties(SNAPSHOT_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, snapshotName: { type: "string" }, force: { type: "boolean" } }), required: ["deviceId", "snapshotName"] } },
    { name: "device_snapshot_restore", description: "Restore an owner-scoped VM snapshot", inputSchema: { type: "object", properties: typedDeviceBrokerProperties(SNAPSHOT_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, snapshotName: { type: "string" }, snapshotId: { type: "string" }, force: { type: "boolean" }, ...CONFIRM_DESTRUCTIVE_PROPERTY }), required: ["deviceId"], anyOf: SNAPSHOT_ID_ANY_OF } },
    { name: "device_snapshot_delete", description: "Delete an owner-scoped VM snapshot", inputSchema: { type: "object", properties: typedDeviceBrokerProperties(SNAPSHOT_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, snapshotName: { type: "string" }, snapshotId: { type: "string" }, ...CONFIRM_DESTRUCTIVE_PROPERTY }), required: ["deviceId"], anyOf: SNAPSHOT_ID_ANY_OF } },
    { name: "device_record_video_start", description: "Start owner-scoped device video recording", inputSchema: { type: "object", properties: typedDeviceBrokerProperties(RECORDING_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, remotePath: { type: "string" }, localPath: { type: "string" }, timeLimitSec: { type: "integer", minimum: 1, maximum: 1800, description: "Whole seconds 1..1800: Android integer 1..180 (default 180); iOS Simulator ignores this and requires stop; Windows Sandbox and macOS VM use a supplied limit, otherwise record until stop." }, helperTimeoutMs: HELPER_TIMEOUT_PROPERTY }), required: ["deviceId"] } },
    { name: "device_record_video_stop", description: "Stop owner-scoped device video recording", inputSchema: { type: "object", properties: typedDeviceBrokerProperties(RECORDING_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, localPath: { type: "string" }, helperTimeoutMs: HELPER_TIMEOUT_PROPERTY }), required: ["deviceId"] } },
    { name: "device_record_video_status", description: "Inspect owner-scoped device video recording state", inputSchema: { type: "object", properties: typedDeviceBrokerProperties(RECORDING_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, helperTimeoutMs: HELPER_TIMEOUT_PROPERTY }), required: ["deviceId"] } },
    { name: "device_upload", description: "Upload a file to an owner-scoped device", inputSchema: { type: "object", properties: typedDeviceBrokerProperties(FILE_TRANSFER_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, localPath: { type: "string", description: "Source project file; broker maps container project paths to the host." }, remotePath: { type: "string", description: "Device path; iOS Simulator: relative to bundleId app container." }, bundleId: { type: "string", description: "iOS app ID." }, containerType: { type: "string", description: "iOS Simulator app container; defaults to data." }, helperTimeoutMs: HELPER_TIMEOUT_PROPERTY, dryRun: { type: "boolean" }, replace: { type: "boolean" }, ...DEVICE_UPLOAD_FILE_POLICY_PROPERTIES }), required: ["deviceId", "localPath", "remotePath"] } },
    { name: "device_download", description: "Download a file from an owner-scoped device", inputSchema: { type: "object", properties: typedDeviceBrokerProperties(FILE_TRANSFER_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, remotePath: { type: "string", description: "Device path; iOS Simulator: relative to bundleId app container." }, localPath: { type: "string", description: "Destination project file; broker maps container project paths to the host." }, bundleId: { type: "string", description: "iOS app ID." }, containerType: { type: "string", description: "iOS Simulator app container; defaults to data." }, helperTimeoutMs: HELPER_TIMEOUT_PROPERTY, dryRun: { type: "boolean" }, replace: { type: "boolean" }, ...BOUNDED_FILE_POLICY_PROPERTIES }), required: ["deviceId", "remotePath", "localPath"] } },
    { name: "device_reset", description: "Reset app or device state", inputSchema: { type: "object", properties: typedDeviceBrokerProperties(RESET_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, packageName: { type: "string", description: "Android app ID." }, bundleId: { type: "string", description: "iOS app ID." }, containerType: { type: "string" }, eraseSimulator: { type: "boolean" }, ...CONFIRM_DESTRUCTIVE_PROPERTY }), required: ["deviceId"], anyOf: RESET_TARGET_ANY_OF } },
    { name: "device_install_app", description: "Install an app package on an owner-scoped device", inputSchema: { type: "object", properties: typedDeviceBrokerProperties(APP_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, path: { type: "string", description: "App package in the project; broker maps container project paths to the host." }, replace: { type: "boolean" }, helperTimeoutMs: HELPER_TIMEOUT_PROPERTY }), required: ["deviceId", "path"] } },
    { name: "device_launch_app", description: "Launch an app on an owner-scoped device", inputSchema: { type: "object", properties: typedDeviceBrokerProperties(APP_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, bundleId: { type: "string", description: "iOS app ID." }, packageName: { type: "string", description: "Android app ID." }, component: { type: "string", description: "Android package/activity for native launch." } }), required: ["deviceId"], anyOf: APP_LAUNCH_ANY_OF } },
    { name: "mobile_session_status", description: "Inspect automation availability and session metadata. Android ADB controls do not require an Appium session.", inputSchema: { type: "object", properties: mobileBrokerProperties({ deviceId: DEVICE_ID_PROPERTY }), required: ["deviceId"] } },
    { name: "mobile_dump_ui", description: "Return a mobile UI hierarchy by the platform automation layer", inputSchema: { type: "object", properties: mobileBrokerProperties({ deviceId: DEVICE_ID_PROPERTY }), required: ["deviceId"] } },
    { name: "mobile_tap", description: "Tap mobile screen coordinates", inputSchema: { type: "object", properties: mobileBrokerProperties({ deviceId: DEVICE_ID_PROPERTY, x: { type: "number" }, y: { type: "number" } }), required: ["deviceId", "x", "y"] } },
    { name: "mobile_double_tap", description: "Double tap mobile screen coordinates", inputSchema: { type: "object", properties: mobileBrokerProperties({ deviceId: DEVICE_ID_PROPERTY, x: { type: "number" }, y: { type: "number" } }), required: ["deviceId", "x", "y"] } },
    { name: "mobile_long_press", description: "Long press mobile screen coordinates", inputSchema: { type: "object", properties: mobileBrokerProperties({ deviceId: DEVICE_ID_PROPERTY, x: { type: "number" }, y: { type: "number" }, durationMs: { type: "number" } }), required: ["deviceId", "x", "y"] } },
    { name: "mobile_swipe", description: "Swipe on a mobile device", inputSchema: { type: "object", properties: mobileBrokerProperties({ deviceId: DEVICE_ID_PROPERTY, x1: { type: "number" }, y1: { type: "number" }, x2: { type: "number" }, y2: { type: "number" }, durationMs: { type: "number" } }), required: ["deviceId", "x1", "y1", "x2", "y2"] } },
    { name: "mobile_drag", description: "Drag between mobile screen coordinates", inputSchema: { type: "object", properties: mobileBrokerProperties({ deviceId: DEVICE_ID_PROPERTY, x1: { type: "number" }, y1: { type: "number" }, x2: { type: "number" }, y2: { type: "number" }, durationMs: { type: "number" } }), required: ["deviceId", "x1", "y1", "x2", "y2"] } },
    { name: "mobile_type_text", description: "Type text on a mobile device", inputSchema: { type: "object", properties: mobileBrokerProperties({ deviceId: DEVICE_ID_PROPERTY, text: { type: "string" } }), required: ["deviceId", "text"] } },
    { name: "mobile_key", description: "Send a mobile key or key code", inputSchema: { type: "object", properties: mobileBrokerProperties({ deviceId: DEVICE_ID_PROPERTY, key: { type: "string", minLength: 1, description: "Android ADB key name, or iOS Appium key value. Use mobile_home for Home." }, keyCode: { type: "integer", description: "Android numeric key code; alternative to key." } }), required: ["deviceId"], anyOf: [{ required: ["key"] }, { required: ["keyCode"] }] } },
    { name: "mobile_home", description: "Send mobile home navigation", inputSchema: { type: "object", properties: mobileBrokerProperties({ deviceId: DEVICE_ID_PROPERTY }), required: ["deviceId"] } },
    { name: "mobile_back", description: "Send mobile back navigation", inputSchema: { type: "object", properties: typedMobileBrokerProperties(ANDROID_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY }), required: ["deviceId"] } },
    { name: "mobile_forward", description: "Send mobile forward navigation", inputSchema: { type: "object", properties: typedMobileBrokerProperties(ANDROID_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY }), required: ["deviceId"] } },
    { name: "mobile_recents", description: "Open mobile app switcher/recents", inputSchema: { type: "object", properties: typedMobileBrokerProperties(ANDROID_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY }), required: ["deviceId"] } },
    { name: "mobile_power", description: "Toggle mobile power control", inputSchema: { type: "object", properties: typedMobileBrokerProperties(ANDROID_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY }), required: ["deviceId"] } },
    { name: "mobile_lock", description: "Lock a mobile device", inputSchema: { type: "object", properties: mobileBrokerProperties({ deviceId: DEVICE_ID_PROPERTY }), required: ["deviceId"] } },
    { name: "mobile_unlock", description: "Wake or unlock a mobile device", inputSchema: { type: "object", properties: mobileBrokerProperties({ deviceId: DEVICE_ID_PROPERTY }), required: ["deviceId"] } },
    { name: "mobile_set_orientation", description: "Set mobile orientation", inputSchema: { type: "object", properties: mobileBrokerProperties({ deviceId: DEVICE_ID_PROPERTY, orientation: { type: "string", enum: ["portrait", "landscape", "reverse-portrait", "reverse-landscape"] } }), required: ["deviceId", "orientation"] } },
    { name: "mobile_open_url", description: "Open a URL on a mobile device", inputSchema: { type: "object", properties: typedMobileBrokerProperties(MOBILE_WITHOUT_IOS_DEVICE_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, url: { type: "string" } }), required: ["deviceId", "url"] } },
    { name: "mobile_uninstall_app", description: "Uninstall an app on a mobile device", inputSchema: { type: "object", properties: typedMobileBrokerProperties(MOBILE_WITHOUT_IOS_DEVICE_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, packageName: { type: "string", description: "Android app ID." }, bundleId: { type: "string", description: "iOS app ID." }, ...CONFIRM_DESTRUCTIVE_PROPERTY }), required: ["deviceId"], anyOf: APP_ID_ANY_OF } },
    { name: "mobile_stop_app", description: "Stop an app on a mobile device", inputSchema: { type: "object", properties: mobileBrokerProperties({ deviceId: DEVICE_ID_PROPERTY, packageName: { type: "string", description: "Android app ID." }, bundleId: { type: "string", description: "iOS app ID." } }), required: ["deviceId"], anyOf: APP_ID_ANY_OF } },
    { name: "mobile_clear_app_data", description: "Clear app data on a mobile device", inputSchema: { type: "object", properties: typedMobileBrokerProperties(RESET_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, packageName: { type: "string", description: "Android app ID." }, bundleId: { type: "string", description: "iOS app ID." }, containerType: { type: "string" }, ...CONFIRM_DESTRUCTIVE_PROPERTY }), required: ["deviceId"], anyOf: APP_ID_ANY_OF } },
    { name: "mobile_grant_permission", description: "Grant an app permission on a mobile device", inputSchema: { type: "object", properties: typedMobileBrokerProperties(MOBILE_WITHOUT_IOS_DEVICE_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, packageName: { type: "string", description: "Android app ID." }, bundleId: { type: "string", description: "iOS app ID." }, permission: { type: "string", description: "Android permission; use packageName." }, service: { type: "string", description: "iOS Simulator privacy service; use bundleId." } }), required: ["deviceId"], anyOf: APP_PERMISSION_ANY_OF } },
    { name: "mobile_revoke_permission", description: "Revoke an app permission on a mobile device", inputSchema: { type: "object", properties: typedMobileBrokerProperties(MOBILE_WITHOUT_IOS_DEVICE_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, packageName: { type: "string", description: "Android app ID." }, bundleId: { type: "string", description: "iOS app ID." }, permission: { type: "string", description: "Android permission; use packageName." }, service: { type: "string", description: "iOS Simulator privacy service; use bundleId." } }), required: ["deviceId"], anyOf: APP_PERMISSION_ANY_OF } },
    { name: "mobile_set_location", description: "Set emulator/simulator location", inputSchema: { type: "object", properties: typedMobileBrokerProperties(EMULATOR_SIMULATOR_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, latitude: { type: "number" }, longitude: { type: "number" }, altitude: { type: "number" } }), required: ["deviceId", "latitude", "longitude"] } },
    { name: "mobile_set_battery", description: "Set mobile battery state", inputSchema: { type: "object", properties: typedMobileBrokerProperties(ANDROID_EMULATOR_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, level: { type: "integer", minimum: 0, maximum: 100, description: "Android simulated battery percentage." }, charging: { type: "boolean", description: "Android simulated AC charger connection." }, status: { type: "integer", minimum: 1, maximum: 5, description: "Android: 1 unknown, 2 charging, 3 discharging, 4 not charging, 5 full." }, ...CONFIRM_DESTRUCTIVE_PROPERTY }), required: ["deviceId"], anyOf: BATTERY_CONTROL_ANY_OF } },
    { name: "mobile_set_network", description: "Set mobile network toggles", inputSchema: { type: "object", properties: typedMobileBrokerProperties(ANDROID_EMULATOR_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, wifi: { type: "boolean" }, data: { type: "boolean" }, ...CONFIRM_DESTRUCTIVE_PROPERTY }), required: ["deviceId"], anyOf: NETWORK_CONTROL_ANY_OF } },
    { name: "mobile_toggle_airplane_mode", description: "Toggle mobile airplane mode", inputSchema: { type: "object", properties: typedMobileBrokerProperties(ANDROID_EMULATOR_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, enabled: { type: "boolean" }, ...CONFIRM_DESTRUCTIVE_PROPERTY }), required: ["deviceId", "enabled"] } },
    { name: "mobile_set_clipboard", description: "Set mobile clipboard text", inputSchema: { type: "object", properties: typedMobileBrokerProperties(MOBILE_WITHOUT_IOS_DEVICE_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, text: { type: "string" } }), required: ["deviceId", "text"] } },
    { name: "mobile_get_clipboard", description: "Get mobile clipboard text", inputSchema: { type: "object", properties: typedMobileBrokerProperties(MOBILE_WITHOUT_IOS_DEVICE_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY }), required: ["deviceId"] } },
    { name: "mobile_wait_for_text", description: "Wait for UI text on Android emulator/device or iOS Simulator/device. timeoutMs defaults to 10000; intervalMs defaults to 500. An unmet condition returns matched:false; observation errors fail. Unmet waits fail flow steps.", inputSchema: { type: "object", properties: mobileBrokerProperties({ deviceId: DEVICE_ID_PROPERTY, text: { type: "string", minLength: 1 }, timeoutMs: BOUNDED_WAIT_TIMEOUT_PROPERTY, intervalMs: BOUNDED_WAIT_INTERVAL_PROPERTY }), required: ["deviceId", "text"] } },
    { name: "mobile_wait_for_app", description: "Wait for the app-running/foreground condition on Android emulator/device or iOS Simulator/device, not UI readiness. timeoutMs defaults to 10000; intervalMs defaults to 500. An unmet condition returns matched:false; unmet waits fail flow steps.", inputSchema: { type: "object", properties: mobileBrokerProperties({ deviceId: DEVICE_ID_PROPERTY, packageName: { type: "string", description: "Android app ID." }, bundleId: { type: "string", description: "iOS app ID." }, timeoutMs: BOUNDED_WAIT_TIMEOUT_PROPERTY, intervalMs: BOUNDED_WAIT_INTERVAL_PROPERTY }), required: ["deviceId"], anyOf: APP_ID_ANY_OF } },
    { name: "device_run_flow", description: "Run desktop/mobile actions in order; share deviceId once. Each destructive step needs confirmation. No lifecycle or nested flows. Fixed arguments, no result interpolation. Unmet waits fail. Screenshots return viewable images with step references.", inputSchema: RUN_FLOW_INPUT_SCHEMA },
].map((tool) => ({
    ...tool,
    inputSchema: {
        ...tool.inputSchema,
        required: (tool.inputSchema.required || []).filter((key) => key !== "backend" || !Object.hasOwn(SINGLE_BACKEND_TOOL_DEFAULTS, tool.name)),
        properties: {
            ...Object.fromEntries(Object.entries(tool.inputSchema.properties).filter(([key]) => key !== "backend" || !Object.hasOwn(SINGLE_BACKEND_TOOL_DEFAULTS, tool.name))),
            detail: { type: "boolean", description: "Include full diagnostic output. Defaults to false." },
        },
    },
}));
