const EXPLICIT_BROKER_ROUTE_PROPERTIES = {
    broker: { type: "boolean" },
    viaBroker: { type: "boolean" },
    implicitBroker: { type: "boolean" },
    autolaunch: { type: "boolean" },
    hostCandidates: { type: "array", items: { type: "string" } },
    launchHost: { type: "string" },
    port: { type: "number", minimum: 1, maximum: 65535 },
    brokerPort: { type: "number", minimum: 1, maximum: 65535 },
    timeoutMs: { type: "number", minimum: 1 },
    rpcTimeoutMs: { type: "number", minimum: 1, maximum: 120000 },
    launchTimeoutMs: { type: "number", minimum: 1 },
};

const HELPER_TIMEOUT_PROPERTY = { type: "number", minimum: 1, maximum: 300000 };
const BOUNDED_WAIT_TIMEOUT_PROPERTY = { type: "number", minimum: 1, maximum: 600000 };
const BOUNDED_WAIT_INTERVAL_PROPERTY = { type: "number", minimum: 1, maximum: 60000 };
const DEVICE_ID_PROPERTY = {
    type: "string",
    minLength: 1,
    maxLength: 128,
    pattern: "^(?!\\.\\.?$)[A-Za-z0-9._-]+$",
};

const EXPLICIT_BROKER_ROUTE_PROPERTIES_WITHOUT_PORT = {
    broker: { type: "boolean" },
    viaBroker: { type: "boolean" },
    implicitBroker: { type: "boolean" },
    autolaunch: { type: "boolean" },
    hostCandidates: { type: "array", items: { type: "string" } },
    launchHost: { type: "string" },
    brokerPort: { type: "number", minimum: 1, maximum: 65535 },
    timeoutMs: { type: "number", minimum: 1 },
    rpcTimeoutMs: { type: "number", minimum: 1, maximum: 120000 },
    launchTimeoutMs: { type: "number", minimum: 1 },
};

const DEVICE_BACKEND_PROPERTY = {
    backend: { type: "string", enum: ["android-emulator", "android-device", "ios-simulator", "ios-device", "windows-sandbox", "macos-vm"] },
};

const DEVICE_WITH_DISPLAY_BACKEND_PROPERTY = {
    backend: { type: "string", enum: ["x11-current-display", "android-emulator", "android-device", "ios-simulator", "ios-device", "windows-sandbox", "macos-vm"] },
};

const DEVICE_DELETE_BACKEND_PROPERTY = {
    backend: { type: "string", enum: ["android-emulator", "ios-simulator", "windows-sandbox", "macos-vm"] },
};

const DEVICE_EXEC_BACKEND_PROPERTY = {
    backend: { type: "string", enum: ["android-emulator", "android-device", "ios-simulator", "windows-sandbox", "macos-vm"] },
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
    backend: { type: "string", enum: ["x11-current-display", "windows-sandbox", "macos-vm"] },
};

const SNAPSHOT_BACKEND_PROPERTY = {
    backend: { type: "string", enum: ["macos-vm"] },
};

const RECORDING_BACKEND_PROPERTY = {
    backend: { type: "string", enum: ["android-emulator", "android-device", "ios-simulator", "windows-sandbox", "macos-vm"] },
};

const FILE_TRANSFER_BACKEND_PROPERTY = {
    backend: { type: "string", enum: ["android-emulator", "android-device", "ios-simulator", "windows-sandbox", "macos-vm"] },
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

const MOBILE_BROKER_ROUTE_PROPERTIES = {
    ...MOBILE_BACKEND_PROPERTY,
    appiumPort: { type: "number", minimum: 1, maximum: 65535 },
    serverPort: { type: "number", minimum: 1, maximum: 65535 },
    automationName: { type: "string" },
    provider: { type: "string" },
    physical: { type: "boolean" },
};

const DEVICE_BROKER_ROUTE_PROPERTIES = {
    ...DEVICE_BACKEND_PROPERTY,
};

const BROKER_MANAGEMENT_ROUTE_PROPERTIES = {};

const CONFIRM_DESTRUCTIVE_PROPERTY = {
    confirmDestructive: { type: "boolean" },
};

function mobileBrokerProperties(properties) {
    return { ...properties, ...MOBILE_BROKER_ROUTE_PROPERTIES };
}

function deviceBrokerProperties(properties) {
    return { ...properties, ...DEVICE_BROKER_ROUTE_PROPERTIES };
}

function typedDeviceBrokerProperties(backendProperty, properties) {
    return { ...properties, ...backendProperty };
}

function typedMobileBrokerProperties(backendProperty, properties) {
    return { ...properties, ...backendProperty, appiumPort: MOBILE_BROKER_ROUTE_PROPERTIES.appiumPort, serverPort: MOBILE_BROKER_ROUTE_PROPERTIES.serverPort, automationName: MOBILE_BROKER_ROUTE_PROPERTIES.automationName, provider: MOBILE_BROKER_ROUTE_PROPERTIES.provider, physical: MOBILE_BROKER_ROUTE_PROPERTIES.physical };
}

function brokerManagementProperties(properties) {
    return { ...properties, ...BROKER_MANAGEMENT_ROUTE_PROPERTIES };
}

const APP_LAUNCH_ANY_OF = [{ required: ["packageName"] }, { required: ["bundleId"] }, { required: ["component"] }];
const APP_ID_ANY_OF = [{ required: ["packageName"] }, { required: ["bundleId"] }];
const APP_PERMISSION_ANY_OF = [{ required: ["packageName", "permission"] }, { required: ["bundleId", "service"] }];
const SNAPSHOT_ID_ANY_OF = [{ required: ["snapshotName"] }, { required: ["snapshotId"] }];
const RESET_TARGET_ANY_OF = [{ required: ["packageName"] }, { required: ["bundleId"] }, { required: ["eraseSimulator"] }];
const BATTERY_CONTROL_ANY_OF = [{ required: ["level"] }, { required: ["status"] }, { required: ["charging"] }];
const NETWORK_CONTROL_ANY_OF = [{ required: ["wifi"] }, { required: ["data"] }];

const RUN_FLOW_INPUT_SCHEMA = {
    type: "object",
    properties: {
        stopOnError: { type: "boolean", description: "Stop after the first rejected or failing step; defaults to true." },
        steps: {
            type: "array",
            maxItems: 50,
            description: "Ordered MCP tool steps to dispatch. Each step names a permitted tool and passes that tool's normal arguments.",
            items: {
                type: "object",
                properties: {
                    tool: { type: "string", description: "Tool name to dispatch." },
                    name: { type: "string", description: "Alias for tool." },
                    label: { type: "string", description: "Optional label copied into the flow result." },
                    arguments: { type: "object", description: "Arguments forwarded to the selected tool." },
                },
                anyOf: [
                    { required: ["tool"] },
                    { required: ["name"] },
                ],
                required: [],
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
        memoryMb: { type: "number" },
        cpus: { type: "number" },
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
        memoryMb: { type: "number" },
        cpus: { type: "number" },
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
        backend: { type: "string", enum: ["android-emulator", "ios-simulator", "windows-sandbox", "macos-vm"] },
        name: { type: "string" },
        deviceId: DEVICE_ID_PROPERTY,
        headless: { type: "boolean" },
        minimized: { type: "boolean" },
        provider: { type: "string", enum: ["auto", "tart", "vz", "utmctl"] },
        image: { type: "string" },
        memoryMb: { type: "number" },
        cpus: { type: "number" },
        sshHost: { type: "string" },
        sshPort: { type: "number" },
        sshUser: { type: "string" },
        sshKeyPath: { type: "string" },
        sshPassword: { type: "string" },
        simulatorName: { type: "string" },
        deviceType: { type: "string" },
        runtime: { type: "string" },
        udid: { type: "string" },
        createSimulator: { type: "boolean" },
        avdName: { type: "string" },
        systemImage: { type: "string" },
        deviceProfile: { type: "string" },
        createAvd: { type: "boolean" },
        port: { type: "number" },
        dryRun: { type: "boolean" },
        networking: { type: "boolean" },
        clipboard: { type: "boolean" },
        vgpu: { type: "boolean" },
        options: { type: "object" },
    },
    required: ["backend", "name"],
};

export const TOOLS = [
    { name: "device_backends", description: "List device-lab backends, availability, and capabilities without starting devices", inputSchema: { type: "object", properties: brokerManagementProperties({}), required: [] } },
    { name: "device_broker_status", description: "Inspect the zero-configuration host broker contract without starting devices", inputSchema: { type: "object", properties: brokerManagementProperties({ probe: { type: "boolean" } }), required: [] } },
    { name: "device_list", description: "List devices and current display targets owned by this CCC container", inputSchema: { type: "object", properties: {}, required: [] } },
    { name: "device_inventory", description: "List owner-scoped device definitions and backend host inventory without starting devices", inputSchema: { type: "object", properties: deviceBrokerProperties({ backend: { type: "string", enum: ["android-emulator", "android-device", "ios-simulator", "ios-device", "windows-sandbox", "macos-vm"] } }), required: [] } },
    { name: "device_wireless", description: "Prepare or inspect native real-device wireless debugging without creating an owner attachment", inputSchema: { type: "object", properties: { backend: { type: "string", enum: ["android-device", "ios-device"] }, action: { type: "string", enum: ["status", "usb-tcpip", "pair", "connect"] }, serial: { type: "string" }, host: { type: "string" }, port: { type: "number" }, pairHost: { type: "string" }, pairPort: { type: "number" }, pairingCode: { type: "string" }, connect: { type: "boolean" }, timeoutMs: { type: "number", minimum: 1, maximum: 30000 } }, required: ["backend"] } },
    { name: "display_current", description: "Return the current non-creatable display target for this CCC container", inputSchema: { type: "object", properties: {}, required: [] } },
    { name: "display_screenshot", description: "Take a screenshot of the current CCC X11 display", inputSchema: { type: "object", properties: {}, required: [] } },
    { name: "display_click", description: "Click at coordinates on the current CCC X11 display", inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, button: { type: "string", enum: ["left", "right"] } }, required: ["x", "y"] } },
    { name: "display_double_click", description: "Double-click at coordinates on the current CCC X11 display", inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, button: { type: "string", enum: ["left", "right"] } }, required: ["x", "y"] } },
    { name: "display_key", description: "Send a key or key combination to the current CCC X11 display using xdotool syntax", inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } },
    { name: "display_type", description: "Type text into the current CCC X11 display", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
    { name: "display_scroll", description: "Scroll at coordinates on the current CCC X11 display", inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, direction: { type: "string", enum: ["up", "down", "left", "right"] }, amount: { type: "number" } }, required: ["x", "y", "direction"] } },
    { name: "display_cursor_position", description: "Get the current mouse cursor position on the CCC X11 display", inputSchema: { type: "object", properties: {}, required: [] } },
    { name: "device_create", description: "Create an owner-scoped device definition", inputSchema: DEVICE_CREATE_INPUT_SCHEMA },
    { name: "device_attach", description: "Attach a host-connected physical device to this CCC owner scope", inputSchema: { type: "object", properties: { backend: { type: "string", enum: ["android-device", "ios-device"] }, name: { type: "string" }, deviceId: DEVICE_ID_PROPERTY, serial: { type: "string" }, udid: { type: "string" }, connection: { type: "string", enum: ["usb", "wifi"] }, host: { type: "string" }, port: { type: "number" } }, required: ["backend"] } },
    { name: "device_detach", description: "Detach an owner-scoped physical device without powering it off", inputSchema: { type: "object", properties: { ...PHYSICAL_BACKEND_PROPERTY, deviceId: DEVICE_ID_PROPERTY }, required: ["deviceId"] } },
    { name: "device_delete", description: "Delete an owner-scoped stopped device definition", inputSchema: { type: "object", properties: typedDeviceBrokerProperties(DEVICE_DELETE_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, force: { type: "boolean" }, deleteAvd: { type: "boolean" }, deleteSimulator: { type: "boolean" }, ...CONFIRM_DESTRUCTIVE_PROPERTY }), required: ["deviceId"] } },
    { name: "device_start", description: "Start an owner-scoped device instance lazily", inputSchema: { type: "object", properties: deviceBrokerProperties({ deviceId: DEVICE_ID_PROPERTY, waitForBoot: { type: "boolean" }, bootTimeoutMs: BOUNDED_WAIT_TIMEOUT_PROPERTY, headless: { type: "boolean" }, minimized: { type: "boolean" } }), required: ["deviceId"] } },
    { name: "device_stop", description: "Stop an owner-scoped device instance", inputSchema: { type: "object", properties: deviceBrokerProperties({ deviceId: DEVICE_ID_PROPERTY }), required: ["deviceId"] } },
    { name: "device_status", description: "Inspect an owner-scoped device definition or instance", inputSchema: { type: "object", properties: typedDeviceBrokerProperties(DEVICE_WITH_DISPLAY_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY }), required: ["deviceId"] } },
    { name: "device_exec", description: "Run a command on an owner-scoped device where supported", inputSchema: { type: "object", properties: typedDeviceBrokerProperties(DEVICE_EXEC_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, command: { type: "string" }, helperTimeoutMs: HELPER_TIMEOUT_PROPERTY }), required: ["deviceId", "command"] } },
    { name: "device_screenshot", description: "Capture a screenshot from an owner-scoped device where supported", inputSchema: { type: "object", properties: typedDeviceBrokerProperties(DEVICE_WITH_DISPLAY_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, helperTimeoutMs: HELPER_TIMEOUT_PROPERTY }), required: ["deviceId"] } },
    { name: "device_click", description: "Click desktop device screen coordinates where supported", inputSchema: { type: "object", properties: typedDeviceBrokerProperties(DISPLAY_DESKTOP_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, x: { type: "number" }, y: { type: "number" }, button: { type: "string", enum: ["left", "right"] }, helperTimeoutMs: HELPER_TIMEOUT_PROPERTY }), required: ["deviceId", "x", "y"] } },
    { name: "device_double_click", description: "Double-click desktop device screen coordinates where supported", inputSchema: { type: "object", properties: typedDeviceBrokerProperties(DISPLAY_DESKTOP_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, x: { type: "number" }, y: { type: "number" }, button: { type: "string", enum: ["left", "right"] }, helperTimeoutMs: HELPER_TIMEOUT_PROPERTY }), required: ["deviceId", "x", "y"] } },
    { name: "device_key", description: "Send a desktop key or key combination where supported", inputSchema: { type: "object", properties: typedDeviceBrokerProperties(DISPLAY_DESKTOP_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, key: { type: "string" }, helperTimeoutMs: HELPER_TIMEOUT_PROPERTY }), required: ["deviceId", "key"] } },
    { name: "device_type", description: "Type text on a desktop device where supported", inputSchema: { type: "object", properties: typedDeviceBrokerProperties(DISPLAY_DESKTOP_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, text: { type: "string" }, helperTimeoutMs: HELPER_TIMEOUT_PROPERTY }), required: ["deviceId", "text"] } },
    { name: "device_scroll", description: "Scroll on a desktop device where supported; some backends require x/y coordinates while macOS scrolls at the current cursor position", inputSchema: { type: "object", properties: typedDeviceBrokerProperties(DISPLAY_DESKTOP_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, x: { type: "number" }, y: { type: "number" }, direction: { type: "string", enum: ["up", "down", "left", "right"] }, amount: { type: "number" }, helperTimeoutMs: HELPER_TIMEOUT_PROPERTY }), required: ["deviceId", "direction"] } },
    { name: "device_cursor_position", description: "Get the current cursor position on a desktop device where supported", inputSchema: { type: "object", properties: typedDeviceBrokerProperties(DISPLAY_DESKTOP_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, helperTimeoutMs: HELPER_TIMEOUT_PROPERTY }), required: ["deviceId"] } },
    { name: "device_window_list", description: "List visible desktop windows where supported", inputSchema: { type: "object", properties: typedDeviceBrokerProperties(DESKTOP_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, helperTimeoutMs: HELPER_TIMEOUT_PROPERTY }), required: ["deviceId"] } },
    { name: "device_accessibility_snapshot", description: "Return a bounded desktop accessibility tree snapshot where supported", inputSchema: { type: "object", properties: typedDeviceBrokerProperties(DESKTOP_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, maxDepth: { type: "number", minimum: 0, maximum: 8 }, maxNodes: { type: "number", minimum: 1, maximum: 1000 }, helperTimeoutMs: HELPER_TIMEOUT_PROPERTY }), required: ["deviceId"] } },
    { name: "device_base_image_create", description: "Create an owner-scoped macOS VM base-image clone from a provider image source", inputSchema: DEVICE_BASE_IMAGE_CREATE_INPUT_SCHEMA },
    { name: "device_base_image_clone", description: "Clone an owner-scoped macOS VM base-image/device definition from a provider source or owned device", inputSchema: DEVICE_BASE_IMAGE_CLONE_INPUT_SCHEMA },
    { name: "device_snapshot_create", description: "Create an owner-scoped VM snapshot where supported", inputSchema: { type: "object", properties: typedDeviceBrokerProperties(SNAPSHOT_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, snapshotName: { type: "string" }, force: { type: "boolean" } }), required: ["deviceId", "snapshotName"] } },
    { name: "device_snapshot_restore", description: "Restore an owner-scoped VM snapshot where supported", inputSchema: { type: "object", properties: typedDeviceBrokerProperties(SNAPSHOT_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, snapshotName: { type: "string" }, snapshotId: { type: "string" }, force: { type: "boolean" }, ...CONFIRM_DESTRUCTIVE_PROPERTY }), required: ["deviceId"], anyOf: SNAPSHOT_ID_ANY_OF } },
    { name: "device_snapshot_delete", description: "Delete an owner-scoped VM snapshot where supported", inputSchema: { type: "object", properties: typedDeviceBrokerProperties(SNAPSHOT_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, snapshotName: { type: "string" }, snapshotId: { type: "string" }, ...CONFIRM_DESTRUCTIVE_PROPERTY }), required: ["deviceId"], anyOf: SNAPSHOT_ID_ANY_OF } },
    { name: "device_record_video_start", description: "Start owner-scoped device video recording where supported", inputSchema: { type: "object", properties: typedDeviceBrokerProperties(RECORDING_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, remotePath: { type: "string" }, localPath: { type: "string" }, timeLimitSec: { type: "number" }, helperTimeoutMs: HELPER_TIMEOUT_PROPERTY }), required: ["deviceId"] } },
    { name: "device_record_video_stop", description: "Stop owner-scoped device video recording where supported", inputSchema: { type: "object", properties: typedDeviceBrokerProperties(RECORDING_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, localPath: { type: "string" }, helperTimeoutMs: HELPER_TIMEOUT_PROPERTY }), required: ["deviceId"] } },
    { name: "device_record_video_status", description: "Inspect owner-scoped device video recording state", inputSchema: { type: "object", properties: typedDeviceBrokerProperties(RECORDING_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, helperTimeoutMs: HELPER_TIMEOUT_PROPERTY }), required: ["deviceId"] } },
    { name: "device_upload", description: "Upload a file to an owner-scoped device where supported", inputSchema: { type: "object", properties: typedDeviceBrokerProperties(FILE_TRANSFER_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, localPath: { type: "string" }, remotePath: { type: "string" }, bundleId: { type: "string" }, containerType: { type: "string" }, helperTimeoutMs: HELPER_TIMEOUT_PROPERTY }), required: ["deviceId", "localPath", "remotePath"] } },
    { name: "device_download", description: "Download a file from an owner-scoped device where supported", inputSchema: { type: "object", properties: typedDeviceBrokerProperties(FILE_TRANSFER_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, remotePath: { type: "string" }, localPath: { type: "string" }, bundleId: { type: "string" }, containerType: { type: "string" }, helperTimeoutMs: HELPER_TIMEOUT_PROPERTY }), required: ["deviceId", "remotePath", "localPath"] } },
    { name: "device_reset", description: "Reset app or device state where supported", inputSchema: { type: "object", properties: typedDeviceBrokerProperties(RESET_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, packageName: { type: "string" }, bundleId: { type: "string" }, containerType: { type: "string" }, eraseSimulator: { type: "boolean" }, ...CONFIRM_DESTRUCTIVE_PROPERTY }), required: ["deviceId"], anyOf: RESET_TARGET_ANY_OF } },
    { name: "device_install_app", description: "Install an app package on an owner-scoped device where supported", inputSchema: { type: "object", properties: typedDeviceBrokerProperties(APP_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, path: { type: "string" }, replace: { type: "boolean" }, helperTimeoutMs: HELPER_TIMEOUT_PROPERTY }), required: ["deviceId", "path"] } },
    { name: "device_launch_app", description: "Launch an app on an owner-scoped device where supported", inputSchema: { type: "object", properties: typedDeviceBrokerProperties(APP_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, bundleId: { type: "string" }, packageName: { type: "string" }, component: { type: "string" } }), required: ["deviceId"], anyOf: APP_LAUNCH_ANY_OF } },
    { name: "mobile_session_status", description: "Inspect mobile Appium automation availability and owner-scoped session metadata", inputSchema: { type: "object", properties: mobileBrokerProperties({ deviceId: DEVICE_ID_PROPERTY }), required: ["deviceId"] } },
    { name: "mobile_dump_ui", description: "Return a mobile UI hierarchy where supported by the platform automation layer", inputSchema: { type: "object", properties: mobileBrokerProperties({ deviceId: DEVICE_ID_PROPERTY }), required: ["deviceId"] } },
    { name: "mobile_tap", description: "Tap mobile screen coordinates where supported", inputSchema: { type: "object", properties: mobileBrokerProperties({ deviceId: DEVICE_ID_PROPERTY, x: { type: "number" }, y: { type: "number" } }), required: ["deviceId", "x", "y"] } },
    { name: "mobile_double_tap", description: "Double tap mobile screen coordinates where supported", inputSchema: { type: "object", properties: mobileBrokerProperties({ deviceId: DEVICE_ID_PROPERTY, x: { type: "number" }, y: { type: "number" } }), required: ["deviceId", "x", "y"] } },
    { name: "mobile_long_press", description: "Long press mobile screen coordinates where supported", inputSchema: { type: "object", properties: mobileBrokerProperties({ deviceId: DEVICE_ID_PROPERTY, x: { type: "number" }, y: { type: "number" }, durationMs: { type: "number" } }), required: ["deviceId", "x", "y"] } },
    { name: "mobile_swipe", description: "Swipe on a mobile device where supported", inputSchema: { type: "object", properties: mobileBrokerProperties({ deviceId: DEVICE_ID_PROPERTY, x1: { type: "number" }, y1: { type: "number" }, x2: { type: "number" }, y2: { type: "number" }, durationMs: { type: "number" } }), required: ["deviceId", "x1", "y1", "x2", "y2"] } },
    { name: "mobile_drag", description: "Drag between mobile screen coordinates where supported", inputSchema: { type: "object", properties: mobileBrokerProperties({ deviceId: DEVICE_ID_PROPERTY, x1: { type: "number" }, y1: { type: "number" }, x2: { type: "number" }, y2: { type: "number" }, durationMs: { type: "number" } }), required: ["deviceId", "x1", "y1", "x2", "y2"] } },
    { name: "mobile_type_text", description: "Type text on a mobile device where supported", inputSchema: { type: "object", properties: mobileBrokerProperties({ deviceId: DEVICE_ID_PROPERTY, text: { type: "string" } }), required: ["deviceId", "text"] } },
    { name: "mobile_key", description: "Send a mobile key or key code where supported", inputSchema: { type: "object", properties: mobileBrokerProperties({ deviceId: DEVICE_ID_PROPERTY, key: { type: "string" }, keyCode: { type: "number" } }), required: ["deviceId"] } },
    { name: "mobile_home", description: "Send mobile home navigation where supported", inputSchema: { type: "object", properties: mobileBrokerProperties({ deviceId: DEVICE_ID_PROPERTY }), required: ["deviceId"] } },
    { name: "mobile_back", description: "Send mobile back navigation where supported", inputSchema: { type: "object", properties: typedMobileBrokerProperties(ANDROID_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY }), required: ["deviceId"] } },
    { name: "mobile_forward", description: "Send mobile forward navigation where supported", inputSchema: { type: "object", properties: typedMobileBrokerProperties(ANDROID_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY }), required: ["deviceId"] } },
    { name: "mobile_recents", description: "Open mobile app switcher/recents where supported", inputSchema: { type: "object", properties: typedMobileBrokerProperties(ANDROID_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY }), required: ["deviceId"] } },
    { name: "mobile_power", description: "Toggle mobile power control where supported", inputSchema: { type: "object", properties: typedMobileBrokerProperties(ANDROID_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY }), required: ["deviceId"] } },
    { name: "mobile_lock", description: "Lock a mobile device where supported", inputSchema: { type: "object", properties: mobileBrokerProperties({ deviceId: DEVICE_ID_PROPERTY }), required: ["deviceId"] } },
    { name: "mobile_unlock", description: "Wake or unlock a mobile device where supported", inputSchema: { type: "object", properties: mobileBrokerProperties({ deviceId: DEVICE_ID_PROPERTY }), required: ["deviceId"] } },
    { name: "mobile_rotate_left", description: "Rotate a mobile device left where supported", inputSchema: { type: "object", properties: mobileBrokerProperties({ deviceId: DEVICE_ID_PROPERTY }), required: ["deviceId"] } },
    { name: "mobile_rotate_right", description: "Rotate a mobile device right where supported", inputSchema: { type: "object", properties: mobileBrokerProperties({ deviceId: DEVICE_ID_PROPERTY }), required: ["deviceId"] } },
    { name: "mobile_set_orientation", description: "Set mobile orientation where supported", inputSchema: { type: "object", properties: mobileBrokerProperties({ deviceId: DEVICE_ID_PROPERTY, orientation: { type: "string", enum: ["portrait", "landscape", "reverse-portrait", "reverse-landscape"] } }), required: ["deviceId", "orientation"] } },
    { name: "mobile_open_url", description: "Open a URL on a mobile device where supported", inputSchema: { type: "object", properties: typedMobileBrokerProperties(MOBILE_WITHOUT_IOS_DEVICE_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, url: { type: "string" } }), required: ["deviceId", "url"] } },
    { name: "mobile_install_app", description: "Install an app on a mobile device where supported", inputSchema: { type: "object", properties: mobileBrokerProperties({ deviceId: DEVICE_ID_PROPERTY, path: { type: "string" }, helperTimeoutMs: HELPER_TIMEOUT_PROPERTY }), required: ["deviceId", "path"] } },
    { name: "mobile_launch_app", description: "Launch an app on a mobile device where supported", inputSchema: { type: "object", properties: mobileBrokerProperties({ deviceId: DEVICE_ID_PROPERTY, bundleId: { type: "string" }, packageName: { type: "string" }, component: { type: "string" } }), required: ["deviceId"], anyOf: APP_LAUNCH_ANY_OF } },
    { name: "mobile_uninstall_app", description: "Uninstall an app on a mobile device where supported", inputSchema: { type: "object", properties: typedMobileBrokerProperties(MOBILE_WITHOUT_IOS_DEVICE_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, packageName: { type: "string" }, bundleId: { type: "string" }, ...CONFIRM_DESTRUCTIVE_PROPERTY }), required: ["deviceId"], anyOf: APP_ID_ANY_OF } },
    { name: "mobile_stop_app", description: "Stop an app on a mobile device where supported", inputSchema: { type: "object", properties: mobileBrokerProperties({ deviceId: DEVICE_ID_PROPERTY, packageName: { type: "string" }, bundleId: { type: "string" } }), required: ["deviceId"], anyOf: APP_ID_ANY_OF } },
    { name: "mobile_clear_app_data", description: "Clear app data on a mobile device where supported", inputSchema: { type: "object", properties: typedMobileBrokerProperties(RESET_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, packageName: { type: "string" }, bundleId: { type: "string" }, containerType: { type: "string" }, ...CONFIRM_DESTRUCTIVE_PROPERTY }), required: ["deviceId"], anyOf: APP_ID_ANY_OF } },
    { name: "mobile_grant_permission", description: "Grant an app permission on a mobile device where supported", inputSchema: { type: "object", properties: typedMobileBrokerProperties(MOBILE_WITHOUT_IOS_DEVICE_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, packageName: { type: "string" }, bundleId: { type: "string" }, permission: { type: "string" }, service: { type: "string" } }), required: ["deviceId"], anyOf: APP_PERMISSION_ANY_OF } },
    { name: "mobile_revoke_permission", description: "Revoke an app permission on a mobile device where supported", inputSchema: { type: "object", properties: typedMobileBrokerProperties(MOBILE_WITHOUT_IOS_DEVICE_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, packageName: { type: "string" }, bundleId: { type: "string" }, permission: { type: "string" }, service: { type: "string" } }), required: ["deviceId"], anyOf: APP_PERMISSION_ANY_OF } },
    { name: "mobile_set_location", description: "Set emulator/simulator location where supported", inputSchema: { type: "object", properties: typedMobileBrokerProperties(EMULATOR_SIMULATOR_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, latitude: { type: "number" }, longitude: { type: "number" }, altitude: { type: "number" } }), required: ["deviceId", "latitude", "longitude"] } },
    { name: "mobile_set_battery", description: "Set mobile battery state where supported", inputSchema: { type: "object", properties: typedMobileBrokerProperties(ANDROID_EMULATOR_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, level: { type: "number" }, charging: { type: "boolean" }, status: { type: "number" }, ...CONFIRM_DESTRUCTIVE_PROPERTY }), required: ["deviceId"], anyOf: BATTERY_CONTROL_ANY_OF } },
    { name: "mobile_set_network", description: "Set mobile network toggles where supported", inputSchema: { type: "object", properties: typedMobileBrokerProperties(ANDROID_EMULATOR_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, wifi: { type: "boolean" }, data: { type: "boolean" }, ...CONFIRM_DESTRUCTIVE_PROPERTY }), required: ["deviceId"], anyOf: NETWORK_CONTROL_ANY_OF } },
    { name: "mobile_toggle_airplane_mode", description: "Toggle mobile airplane mode where supported", inputSchema: { type: "object", properties: typedMobileBrokerProperties(ANDROID_EMULATOR_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, enabled: { type: "boolean" }, ...CONFIRM_DESTRUCTIVE_PROPERTY }), required: ["deviceId", "enabled"] } },
    { name: "mobile_set_clipboard", description: "Set mobile clipboard text where supported", inputSchema: { type: "object", properties: typedMobileBrokerProperties(MOBILE_WITHOUT_IOS_DEVICE_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY, text: { type: "string" } }), required: ["deviceId", "text"] } },
    { name: "mobile_get_clipboard", description: "Get mobile clipboard text where supported", inputSchema: { type: "object", properties: typedMobileBrokerProperties(MOBILE_WITHOUT_IOS_DEVICE_BACKEND_PROPERTY, { deviceId: DEVICE_ID_PROPERTY }), required: ["deviceId"] } },
    { name: "mobile_wait_for_text", description: "Wait for text in a mobile UI hierarchy where supported", inputSchema: { type: "object", properties: mobileBrokerProperties({ deviceId: DEVICE_ID_PROPERTY, text: { type: "string" }, timeoutMs: BOUNDED_WAIT_TIMEOUT_PROPERTY, intervalMs: BOUNDED_WAIT_INTERVAL_PROPERTY }), required: ["deviceId", "text"] } },
    { name: "mobile_wait_for_app", description: "Wait for an app process to appear where supported", inputSchema: { type: "object", properties: mobileBrokerProperties({ deviceId: DEVICE_ID_PROPERTY, packageName: { type: "string" }, bundleId: { type: "string" }, timeoutMs: BOUNDED_WAIT_TIMEOUT_PROPERTY, intervalMs: BOUNDED_WAIT_INTERVAL_PROPERTY }), required: ["deviceId"], anyOf: APP_ID_ANY_OF } },
    { name: "mobile_screenshot", description: "Capture a mobile screenshot where supported", inputSchema: { type: "object", properties: mobileBrokerProperties({ deviceId: DEVICE_ID_PROPERTY }), required: ["deviceId"] } },
    { name: "mobile_run_flow", description: "Run a bounded sequence of mobile verification actions through existing device handlers", inputSchema: RUN_FLOW_INPUT_SCHEMA },
    { name: "device_run_flow", description: "Run a bounded sequence of target-neutral verification actions through existing display, desktop, and mobile handlers", inputSchema: RUN_FLOW_INPUT_SCHEMA },
];
