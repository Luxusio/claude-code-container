export type BrokerAppiumExecution = {status?: number | null; error?: string; pid?: number; processIdentity?: unknown; receipt: unknown};
/** Genuine Appium/WebDriver HTTP protocol evidence, not a CCC response. */
export type BrokerAppiumHttpResponse = {ok: boolean; status: number | null; body: unknown};
export type BrokerAppiumVerification = {ok: true; serverUrl: string; port?: number; receipt: unknown} | {ok: false; error: string; receipt: unknown};
export type BrokerAppiumTermination = {ok: boolean; error?: string; stale?: boolean; attempted?: boolean; receipt: unknown};
export type BrokerAppiumInstrumentationRecovery = {attempted: boolean; ok: boolean; error?: string; results: BrokerAppiumExecution[]; receipt?: unknown};
export type BrokerAppiumRuntimeFailure = {ok: false; error: string; detail?: string; receipt: unknown; execution?: BrokerAppiumExecution};
export type BrokerAppiumRefusal = {
    kind: "refused"; reason: "invalid" | "forbidden" | "missing" | "conflict" | "provider-failed" | "state-read-failed" | "deadline";
    error: string; allowed?: string[]; ownerId?: string; backend?: string; stateKey?: string; deviceId?: string;
    detail?: string; missing?: unknown; leaseError?: string; remedy?: string; appium?: unknown; found?: boolean; currentAppium?: unknown;
    response?: BrokerAppiumHttpResponse; rollback?: BrokerAppiumTermination | BrokerAppiumHttpResponse; verification?: BrokerAppiumVerification;
    readiness?: {ok: boolean; response: BrokerAppiumHttpResponse | null}; signal?: BrokerAppiumTermination;
    replaced?: BrokerAppiumTermination; portSelection?: unknown; portCleanup?: BrokerAppiumTermination;
    runtime?: BrokerAppiumRuntimeFailure; execution?: BrokerAppiumExecution; statusObservation?: BrokerAppiumHttpResponse; sessionObservation?: BrokerAppiumHttpResponse | null;
    instrumentationRecovery?: BrokerAppiumInstrumentationRecovery;
};
export type BrokerAppiumContext = {ownerId: string; backend: string; stateKey: string; deviceId: string};
export type BrokerAppiumResponse = BrokerAppiumRefusal
    | (BrokerAppiumContext & {kind: "metadata-recorded"; device: Record<string, unknown> | null; appium: Record<string, unknown>})
    | (BrokerAppiumContext & {kind: "metadata-cleared"; device: Record<string, unknown> | null; cleared: true})
    | (BrokerAppiumContext & {kind: "server-reused"; device: unknown; appium: unknown; started: false; reused: true})
    | (BrokerAppiumContext & {kind: "server-started"; appium: Record<string, unknown>; started: true; reused: false; replaced: BrokerAppiumTermination; execution: BrokerAppiumExecution; portCleanup: BrokerAppiumTermination; portSelection: unknown; runtime: {provisioned: boolean; source: "provider-path" | "broker-runtime"}; session: null})
    | (BrokerAppiumContext & {kind: "server-stopped"; stopped: true; stalePid: boolean; signal: BrokerAppiumTermination})
    | (BrokerAppiumContext & {kind: "session-created" | "session-reused"; appium: Record<string, unknown>; device?: unknown; created: boolean; reused: boolean; response?: BrokerAppiumHttpResponse})
    | (BrokerAppiumContext & {kind: "session-deleted"; deleted: boolean; appium?: Record<string, unknown>; device?: unknown; response?: BrokerAppiumHttpResponse})
    | (BrokerAppiumContext & {kind: "session-delete-failed"; error: "appium-session-delete-failed"; appium: Record<string, unknown>; deleted?: false; created?: false; reused?: false; response: BrokerAppiumHttpResponse})
    | (BrokerAppiumContext & {kind: "request-completed" | "request-failed"; error?: "appium-request-failed"; method: DeviceBrokerAppiumRequestMethod; path: string; response: BrokerAppiumHttpResponse});

export type BrokerAppiumRecordOutcome = BrokerAppiumRefusal | Extract<BrokerAppiumResponse, {kind: "metadata-recorded"}>;
export type BrokerAppiumClearOutcome = BrokerAppiumRefusal | Extract<BrokerAppiumResponse, {kind: "metadata-cleared"}>;
export type BrokerAppiumStartOutcome = BrokerAppiumRefusal | Extract<BrokerAppiumResponse, {kind: "server-started" | "server-reused"}>;
export type BrokerAppiumStopOutcome = BrokerAppiumRefusal | Extract<BrokerAppiumResponse, {kind: "server-stopped"}>;
export type BrokerAppiumSessionOutcome = BrokerAppiumRefusal | Extract<BrokerAppiumResponse, {kind: "session-created" | "session-reused" | "session-delete-failed"}>;
export type BrokerAppiumDeleteSessionOutcome = BrokerAppiumRefusal | Extract<BrokerAppiumResponse, {kind: "session-deleted" | "session-delete-failed"}>;
export type BrokerAppiumRequestOutcome = BrokerAppiumRefusal | Extract<BrokerAppiumResponse, {kind: "request-completed" | "request-failed"}>;

export type BrokerAppiumBudget = { remaining(): number };
export type AppiumParamError = { ok: false; reason: "invalid" | "forbidden"; error: string; allowed?: string[] };
export type AppiumParamSuccess = {
    ok: true;
    backend: string;
    stateKey: string;
    deviceId: string;
};
export type AppiumMetadataResult = { ok: true; appium: Record<string, unknown> } | { ok: false; reason: "invalid" | "forbidden"; error: string };
export type AppiumRequestParamError = { ok: false; reason: "invalid" | "forbidden"; error: string; allowed?: string[] };
export type AppiumRequestParamSuccess = AppiumParamSuccess & {
    method: DeviceBrokerAppiumRequestMethod;
    path: string;
    body: unknown;
};
export type AppiumRequestBodyValidation = { ok: true } | { ok: false; reason: "invalid" | "forbidden"; error: string; allowed?: string[] };
export type DeviceBrokerAppiumRequestMethod = "GET" | "POST";
const DEVICE_BROKER_APPIUM_BACKENDS = new Map([
    ["android-emulator", "android"],
    ["android-device", "android-device"],
    ["ios-simulator", "ios"],
    ["ios-device", "ios-device"],
]);
const DEVICE_BROKER_APPIUM_REQUEST_ALLOWLIST = new Map<string, ReadonlySet<DeviceBrokerAppiumRequestMethod>>([
    ["/source", new Set(["GET"])],
    ["/screenshot", new Set(["GET"])],
    ["/actions", new Set(["POST"])],
    ["/keys", new Set(["POST"])],
    ["/back", new Set(["POST"])],
    ["/orientation", new Set(["POST"])],
    ["/url", new Set(["POST"])],
    ["/location", new Set(["POST"])],
    ["/execute/sync", new Set(["POST"])],
    ["/appium/device/press_keycode", new Set(["POST"])],
    ["/appium/device/install_app", new Set(["POST"])],
    ["/appium/device/activate_app", new Set(["POST"])],
    ["/appium/device/remove_app", new Set(["POST"])],
    ["/appium/device/terminate_app", new Set(["POST"])],
    ["/appium/device/set_clipboard", new Set(["POST"])],
    ["/appium/device/get_clipboard", new Set(["POST"])],
    ["/appium/device/app_state", new Set(["POST"])],
]);
export const DEVICE_BROKER_RPC_BODY_LIMIT = 64 * 1024;
const DEVICE_BROKER_APPIUM_FETCH_MAX_TIMEOUT_MS = 300000;
const DEVICE_BROKER_APPIUM_REQUEST_TIMEOUT_MS = 30000;
function field(device: unknown, name: string): string | null {
    if (!device || typeof device !== "object") return null;
    const value = (device as Record<string, unknown>)[name];
    return typeof value === "string" && value ? value : null;
}
function numberField(device: unknown, name: string): number | null {
    if (!device || typeof device !== "object") return null;
    const value = (device as Record<string, unknown>)[name];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function androidSerial(device: unknown) {
    return field(device, "serial") || (numberField(device, "port") ? `emulator-${numberField(device, "port")}` : null);
}
export function validateAppiumParams(params: unknown, action: "status" | "record" | "clear" | "start" | "stop" | "session" | "delete-session" | "request"): AppiumParamError | AppiumParamSuccess {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
        return { ok: false, reason: "invalid", error: "invalid-appium-params" };
    }
    const input = params as Record<string, unknown>;
    const backend = typeof input.backend === "string" ? input.backend : "";
    const stateKey = DEVICE_BROKER_APPIUM_BACKENDS.get(backend);
    if (!stateKey) {
        return { ok: false, reason: "invalid", error: "invalid-appium-backend", allowed: [...DEVICE_BROKER_APPIUM_BACKENDS.keys()] };
    }
    const deviceId = typeof input.deviceId === "string" ? input.deviceId.trim() : "";
    if (!deviceId || deviceId.length > 128 || /[^a-zA-Z0-9._:-]/.test(deviceId)) {
        return { ok: false, reason: "invalid", error: action === "record" ? "invalid-device-id" : "invalid-appium-device-id" };
    }
    return { ok: true, backend, stateKey, deviceId };
}

export function allowedAppiumRequests() {
    return [...DEVICE_BROKER_APPIUM_REQUEST_ALLOWLIST.entries()]
        .flatMap(([path, methods]) => [...methods].map((method) => `${method} ${path}`));
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function jsonBodySize(value: unknown) {
    try {
        const text = JSON.stringify(value);
        return typeof text === "string" ? new TextEncoder().encode(text).byteLength : Infinity;
    } catch {
        return Infinity;
    }
}

export function safeText(value: unknown, maxLength = 512): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= maxLength && !/[\u0000-\u001f]/.test(value);
}

export function safeAbsolutePath(value: unknown) {
    return safeText(value, 1024) && value.startsWith("/") && !value.includes("..") && !value.includes("://");
}

export function safeAppId(value: unknown) {
    return safeText(value, 256) && /^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)+$/.test(value);
}

export function safeAndroidComponent(value: unknown) {
    return safeText(value, 256) && /^[A-Za-z][A-Za-z0-9_.$]*(?:\.[A-Za-z][A-Za-z0-9_.$]*)*\/\.?[A-Za-z][A-Za-z0-9_.$]*$/.test(value);
}

export function emptyOrPlainBody(body: unknown) {
    return body === null || isPlainRecord(body);
}

export function validateAndroidShellRequest(command: unknown, args: unknown): AppiumRequestBodyValidation {
    if (command === "svc" && Array.isArray(args) && args.every((arg) => typeof arg === "string")) {
        const [service, action] = args;
        if (args.length === 2 && ["wifi", "data"].includes(service) && ["enable", "disable"].includes(action)) {
            return { ok: true };
        }
    }
    if (command === "settings" && Array.isArray(args) && args.every((arg) => typeof arg === "string")) {
        const [verb, namespace, key, value] = args;
        if (args.length === 4 && verb === "put" && namespace === "system" && key === "accelerometer_rotation" && ["0", "1"].includes(value)) {
            return { ok: true };
        }
        if (args.length === 4 && verb === "put" && namespace === "system" && key === "user_rotation" && ["0", "1", "2", "3"].includes(value)) {
            return { ok: true };
        }
        if (args.length === 4 && verb === "put" && namespace === "global" && key === "airplane_mode_on" && ["0", "1"].includes(value)) {
            return { ok: true };
        }
    }
    if (command === "am" && Array.isArray(args) && args.length === 3 && args[0] === "start" && args[1] === "-n" && safeAndroidComponent(args[2])) {
        return { ok: true };
    }
    if (command === "am" && Array.isArray(args) && args.every((arg) => typeof arg === "string")) {
        if (args.length === 6 && args[0] === "broadcast" && args[1] === "-a" && args[2] === "android.intent.action.AIRPLANE_MODE" && args[3] === "--ez" && args[4] === "state" && ["true", "false"].includes(args[5])) {
            return { ok: true };
        }
    }
    if (command === "pm" && Array.isArray(args) && args.length === 2 && args[0] === "clear" && safeAppId(args[1])) {
        return { ok: true };
    }
    return { ok: false, reason: "forbidden", error: "disallowed-appium-mobile-shell-command", allowed: ["settings put system accelerometer_rotation", "settings put system user_rotation", "settings put global airplane_mode_on", "svc wifi|data enable|disable", "am broadcast airplane mode", "am start -n <component>", "pm clear <package>"] };
}

export function validateAppiumExecuteSyncBody(backend: string, body: unknown): AppiumRequestBodyValidation {
    if (!isPlainRecord(body) || typeof body.script !== "string") {
        return { ok: false, reason: "invalid", error: "invalid-appium-execute-sync-body" };
    }
    const args = body.args;
    if (body.script === "mobile: shell") {
        if (!backend.startsWith("android") || !Array.isArray(args) || args.length !== 1 || !isPlainRecord(args[0])) {
            return { ok: false, reason: "forbidden", error: "disallowed-appium-mobile-shell-command" };
        }
        return validateAndroidShellRequest(args[0].command, args[0].args);
    }
    if (body.script === "mobile: activeAppInfo" && backend.startsWith("ios") && Array.isArray(args) && args.length === 0) {
        return { ok: true };
    }
    if (body.script === "mobile: pressButton" && backend.startsWith("ios") && Array.isArray(args) && args.length === 1 && isPlainRecord(args[0]) && args[0].name === "home") {
        return { ok: true };
    }
    if ((body.script === "mobile: lock" || body.script === "mobile: unlock") && backend.startsWith("ios") && Array.isArray(args) && args.length === 0) {
        return { ok: true };
    }
    return { ok: false, reason: "forbidden", error: "disallowed-appium-mobile-script", allowed: ["mobile: activeAppInfo", "mobile: pressButton home", "mobile: lock", "mobile: unlock", "mobile: shell allowlist"] };
}

export function validateAppiumRequestBody(backend: string, method: DeviceBrokerAppiumRequestMethod, path: string, body: unknown): AppiumRequestBodyValidation {
    const allowedMethods = DEVICE_BROKER_APPIUM_REQUEST_ALLOWLIST.get(path);
    if (!allowedMethods?.has(method)) {
        return { ok: false, reason: "forbidden", error: "disallowed-appium-request", allowed: allowedAppiumRequests() };
    }
    if (method === "GET") {
        return body === null ? { ok: true } : { ok: false, reason: "invalid", error: "invalid-appium-request-body" };
    }
    if (!emptyOrPlainBody(body)) {
        return { ok: false, reason: "invalid", error: "invalid-appium-request-body" };
    }
    if (path === "/execute/sync") return validateAppiumExecuteSyncBody(backend, body);
    if (path === "/actions") return isPlainRecord(body) && Array.isArray(body.actions) && body.actions.length > 0 && body.actions.length <= 8
        ? { ok: true }
        : { ok: false, reason: "invalid", error: "invalid-appium-actions-body" };
    if (path === "/keys") return isPlainRecord(body) && safeText(body.text, 4096) && Array.isArray(body.value) && body.value.every((entry) => typeof entry === "string")
        ? { ok: true }
        : { ok: false, reason: "invalid", error: "invalid-appium-keys-body" };
    if (path === "/back") return isPlainRecord(body) && Object.keys(body).length === 0
        ? { ok: true }
        : { ok: false, reason: "invalid", error: "invalid-appium-back-body" };
    if (path === "/orientation") return isPlainRecord(body) && typeof body.orientation === "string" && ["PORTRAIT", "LANDSCAPE"].includes(body.orientation)
        ? { ok: true }
        : { ok: false, reason: "invalid", error: "invalid-appium-orientation-body" };
    if (path === "/url") return isPlainRecord(body) && safeText(body.url, 2048) && /^[a-z][a-z0-9+.-]*:/i.test(body.url)
        ? { ok: true }
        : { ok: false, reason: "invalid", error: "invalid-appium-url-body" };
    if (path === "/location") {
        const location = isPlainRecord(body) ? body.location : null;
        return isPlainRecord(location)
            && typeof location.latitude === "number" && Number.isFinite(location.latitude) && location.latitude >= -90 && location.latitude <= 90
            && typeof location.longitude === "number" && Number.isFinite(location.longitude) && location.longitude >= -180 && location.longitude <= 180
            && (location.altitude === undefined || (typeof location.altitude === "number" && Number.isFinite(location.altitude)))
            ? { ok: true }
            : { ok: false, reason: "invalid", error: "invalid-appium-location-body" };
    }
    if (path === "/appium/device/press_keycode") return backend.startsWith("android") && isPlainRecord(body) && Number.isInteger(body.keycode) && Number(body.keycode) >= 0 && Number(body.keycode) <= 300
        ? { ok: true }
        : { ok: false, reason: "forbidden", error: "disallowed-appium-press-keycode" };
    if (path === "/appium/device/install_app") return isPlainRecord(body) && safeAbsolutePath(body.appPath)
        ? { ok: true }
        : { ok: false, reason: "invalid", error: "invalid-appium-install-app-body" };
    if (["/appium/device/activate_app", "/appium/device/remove_app", "/appium/device/terminate_app", "/appium/device/app_state"].includes(path)) {
        return isPlainRecord(body) && safeAppId(body.appId)
            ? { ok: true }
            : { ok: false, reason: "invalid", error: "invalid-appium-app-id-body" };
    }
    if (path === "/appium/device/set_clipboard") return isPlainRecord(body) && safeText(body.content, 16384) && body.contentType === "plaintext" && (body.label === undefined || safeText(body.label, 128))
        ? { ok: true }
        : { ok: false, reason: "invalid", error: "invalid-appium-clipboard-body" };
    if (path === "/appium/device/get_clipboard") return isPlainRecord(body) && body.contentType === "plaintext"
        ? { ok: true }
        : { ok: false, reason: "invalid", error: "invalid-appium-clipboard-body" };
    return { ok: false, reason: "forbidden", error: "disallowed-appium-request", allowed: allowedAppiumRequests() };
}

export function validateAppiumRequestParams(params: unknown): AppiumRequestParamError | AppiumRequestParamSuccess {
    const parsed = validateAppiumParams(params, "request");
    if (!parsed.ok) return parsed;
    const input = params as Record<string, unknown>;
    if (input.requestTimeoutMs !== undefined && (typeof input.requestTimeoutMs !== "number"
        || !Number.isFinite(input.requestTimeoutMs) || input.requestTimeoutMs <= 0 || input.requestTimeoutMs > 600000)) {
        return { ok: false, reason: "invalid", error: "invalid-appium-request-timeout" };
    }
    const method = typeof input.method === "string" ? input.method.toUpperCase() : "GET";
    if (!["GET", "POST"].includes(method)) {
        return { ok: false, reason: "invalid", error: "invalid-appium-request-method", allowed: ["GET", "POST"] };
    }
    const path = typeof input.path === "string" ? input.path.trim() : "";
    if (!path || path.length > 512 || !path.startsWith("/") || path.includes("://") || path.includes("..") || /[\u0000-\u001f]/.test(path)) {
        return { ok: false, reason: "invalid", error: "invalid-appium-request-path" };
    }
    const body = input.body ?? null;
    if (body !== null && (!isPlainRecord(body) || jsonBodySize(body) > DEVICE_BROKER_RPC_BODY_LIMIT)) {
        return { ok: false, reason: "invalid", error: "invalid-appium-request-body" };
    }
    const bodyValidation = validateAppiumRequestBody(parsed.backend, method as DeviceBrokerAppiumRequestMethod, path, body);
    if (!bodyValidation.ok) return bodyValidation;
    return { ...parsed, method: method as DeviceBrokerAppiumRequestMethod, path, body };
}

export function requestedAppiumPort(params: unknown) {
    if (!params || typeof params !== "object" || Array.isArray(params)) return null;
    const input = params as Record<string, unknown>;
    const value = input.port ?? input.appiumPort ?? input.serverPort;
    return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535 ? value : null;
}

export function appiumAutomationName(backend: string) {
    return backend.startsWith("android") ? "UiAutomator2" : "XCUITest";
}

export function appiumProviderName(backend: string) {
    return backend.startsWith("android") ? "appium-uiautomator2" : "appium-xcuitest";
}

export function appiumCapabilities(backend: string, device: unknown) {
    if (!device || typeof device !== "object") return {};
    const record = device as Record<string, unknown>;
    if (backend.startsWith("android")) {
        const serial = androidSerial(device);
        return {
            platformName: "Android",
            "appium:automationName": "UiAutomator2",
            "appium:deviceName": field(device, "name") || field(device, "id") || backend,
            "appium:adbExecTimeout": 120000,
            "appium:uiautomator2ServerInstallTimeout": 120000,
            "appium:uiautomator2ServerLaunchTimeout": 120000,
            ...(serial ? { "appium:udid": serial } : {}),
            ...(typeof record.avdName === "string" && record.avdName ? { "appium:avd": record.avdName } : {}),
        };
    }
    return {
        platformName: "iOS",
        "appium:automationName": "XCUITest",
        "appium:deviceName": field(device, "simulatorName") || field(device, "name") || field(device, "id") || backend,
        ...(typeof record.udid === "string" && record.udid ? { "appium:udid": record.udid } : {}),
        ...(backend === "ios-device" ? { "appium:realDevice": true } : {}),
    };
}

export function appiumInstrumentationInitializationFailed(response: { body: unknown }) {
    const text = JSON.stringify(response.body || {}).toLowerCase();
    return text.includes("instrumentation process cannot be initialized")
        || text.includes("uiautomator2 server cannot be started");
}

export function brokerOwnedAppiumPid(appium: unknown) {
    if (!appium || typeof appium !== "object") return null;
    const metadata = appium as { authority?: unknown; serverPid?: unknown; processOwner?: unknown; startedBy?: unknown };
    if (metadata.authority !== "host-broker"
        || metadata.processOwner !== "host-broker"
        || metadata.startedBy !== "broker.appium.start") return null;
    return typeof metadata.serverPid === "number" && Number.isInteger(metadata.serverPid) && metadata.serverPid > 0
        ? metadata.serverPid
        : null;
}

export function claimsBrokerOwnedAppiumRuntime(appium: unknown) {
    if (!appium || typeof appium !== "object" || Array.isArray(appium)) return false;
    const metadata = appium as { authority?: unknown; processOwner?: unknown; startedBy?: unknown };
    return metadata.authority === "host-broker"
        && metadata.processOwner === "host-broker"
        && metadata.startedBy === "broker.appium.start";
}

export function brokerOwnedAppiumEndpoint(appium: unknown) {
    if (!appium || typeof appium !== "object" || Array.isArray(appium)) {
        return { ok: false as const, error: "appium-runtime-metadata-incomplete" };
    }
    const metadata = appium as { authority?: unknown; serverUrl?: unknown; port?: unknown; processOwner?: unknown; startedBy?: unknown };
    if (metadata.authority !== "host-broker"
        || metadata.processOwner !== "host-broker"
        || metadata.startedBy !== "broker.appium.start"
        || typeof metadata.serverUrl !== "string") {
        return { ok: false as const, error: "appium-runtime-metadata-incomplete" };
    }

    // Broker-launched Appium always listens at the loopback origin root. Keeping this
    // grammar deliberately narrow rejects URL parser aliases, credentials, path
    // prefixes, query strings, and fragments before any host request is attempted.
    const match = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/?$/.exec(metadata.serverUrl);
    if (!match) {
        return { ok: false as const, error: "appium-server-url-unsafe", serverUrl: metadata.serverUrl };
    }
    const urlPort = Number(match[1]);
    if (!Number.isInteger(urlPort) || urlPort <= 0 || urlPort > 65535) {
        return { ok: false as const, error: "appium-server-url-unsafe", serverUrl: metadata.serverUrl };
    }
    if (metadata.port !== undefined
        && (typeof metadata.port !== "number"
            || !Number.isInteger(metadata.port)
            || metadata.port !== urlPort)) {
        return {
            ok: false as const,
            error: "appium-server-url-port-mismatch",
            port: metadata.port,
            urlPort,
            serverUrl: metadata.serverUrl,
        };
    }
    return { ok: true as const, port: urlPort, serverUrl: `http://127.0.0.1:${urlPort}` };
}

export function brokerLaunchedAppiumServerUrl(appium: unknown) {
    const endpoint = brokerOwnedAppiumEndpoint(appium);
    return endpoint.ok ? endpoint.serverUrl : null;
}

export function brokerOwnedAppiumPort(appium: unknown) {
    const endpoint = brokerOwnedAppiumEndpoint(appium);
    return endpoint.ok ? endpoint.port : null;
}

export function brokerOwnedAppiumRuntime(appium: unknown) {
    if (!appium || typeof appium !== "object" || Array.isArray(appium)) return null;
    const metadata = appium as Record<string, unknown>;
    const pid = brokerOwnedAppiumPid(metadata);
    if (!pid) return null;
    return {
        runtimeId: metadata.runtimeId,
        pid,
        processIdentity: metadata.processIdentity,
    };
}

export function stringMetadataField(input: Record<string, unknown>, name: string, maxLength: number) {
    const value = input[name];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > maxLength || /[\u0000-\u001f]/.test(trimmed)) return null;
    return trimmed;
}

export function numberMetadataField(input: Record<string, unknown>, name: string, min: number, max: number) {
    const value = input[name];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) return null;
    return value;
}

export function appiumMetadata(params: unknown): AppiumMetadataResult {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
        return { ok: false, reason: "invalid", error: "invalid-appium-params" };
    }
    const root = params as Record<string, unknown>;
    const nested = root.appium && typeof root.appium === "object" && !Array.isArray(root.appium)
        ? root.appium as Record<string, unknown>
        : null;
    const input = nested ? { ...root, ...nested } : root;
    const serverUrl = stringMetadataField(input, "serverUrl", 2048);
    if (serverUrl === null) return { ok: false, reason: "invalid", error: "invalid-appium-server-url" };
    if (serverUrl !== undefined) {
        try {
            const parsed = new URL(serverUrl);
            if (!["http:", "https:"].includes(parsed.protocol)) return { ok: false, reason: "invalid", error: "invalid-appium-server-url" };
        } catch {
            return { ok: false, reason: "invalid", error: "invalid-appium-server-url" };
        }
    }
    const sessionId = stringMetadataField(input, "sessionId", 512);
    if (sessionId === null) return { ok: false, reason: "invalid", error: "invalid-appium-session-id" };
    const automationName = stringMetadataField(input, "automationName", 128);
    if (automationName === null) return { ok: false, reason: "invalid", error: "invalid-appium-automation-name" };
    const provider = stringMetadataField(input, "provider", 128);
    if (provider === null) return { ok: false, reason: "invalid", error: "invalid-appium-provider" };
    const serverPid = numberMetadataField(input, "serverPid", 1, Number.MAX_SAFE_INTEGER);
    if (serverPid === null) return { ok: false, reason: "invalid", error: "invalid-appium-server-pid" };
    const port = numberMetadataField(input, "port", 1, 65535);
    if (port === null) return { ok: false, reason: "invalid", error: "invalid-appium-port" };
    const physical = input.physical;
    if (physical !== undefined && typeof physical !== "boolean") {
        return { ok: false, reason: "invalid", error: "invalid-appium-physical" };
    }
    const metadata: Record<string, unknown> = {
        authority: "host-broker",
    };
    if (serverUrl !== undefined) metadata.serverUrl = serverUrl;
    if (sessionId !== undefined) metadata.sessionId = sessionId;
    if (automationName !== undefined) metadata.automationName = automationName;
    if (provider !== undefined) metadata.provider = provider;
    if (serverPid !== undefined) metadata.serverPid = serverPid;
    if (port !== undefined) metadata.port = port;
    if (physical !== undefined) metadata.physical = physical;
    if (!metadata.serverUrl && !metadata.sessionId && !metadata.serverPid && !metadata.port) {
        return { ok: false, reason: "invalid", error: "missing-appium-metadata" };
    }
    return { ok: true, appium: metadata };
}

export function appiumRuntimeMatches(expected: unknown, current: unknown): boolean {
    if (expected === null || expected === undefined) return current === null || current === undefined;
    if (!expected || typeof expected !== "object" || Array.isArray(expected)
        || !current || typeof current !== "object" || Array.isArray(current)) return false;
    const expectedRecord = expected as Record<string, unknown>;
    const currentRecord = current as Record<string, unknown>;
    const expectedRuntimeId = typeof expectedRecord.runtimeId === "string" ? expectedRecord.runtimeId : null;
    const currentRuntimeId = typeof currentRecord.runtimeId === "string" ? currentRecord.runtimeId : null;
    if (expectedRuntimeId || currentRuntimeId) return expectedRuntimeId !== null && expectedRuntimeId === currentRuntimeId;
    const identityFields = ["authority", "processOwner", "startedBy", "serverPid", "serverUrl", "updatedAt"];
    return identityFields.every((field) => expectedRecord[field] === currentRecord[field]);
}

export function appiumRuntimeOperationError(error: unknown, fallback: string): string {
    const message = error instanceof Error ? error.message : "";
    return /^appium-runtime-[a-z0-9-]+$/.test(message) ? message : fallback;
}

export function appiumParamError(parsed: AppiumParamError): BrokerAppiumRefusal {
    return {kind: "refused", reason: parsed.reason, error: parsed.error, ...(parsed.allowed ? {allowed: parsed.allowed} : {})};
}

export function appiumWebDriverRequestTimeoutMs(commandTimeoutMs: number) {
    return Math.min(
        DEVICE_BROKER_APPIUM_FETCH_MAX_TIMEOUT_MS,
        Math.max(DEVICE_BROKER_APPIUM_REQUEST_TIMEOUT_MS, Number.isFinite(commandTimeoutMs) ? commandTimeoutMs : 0),
    );
}


/** Publication projection after the native mutation lock verifies the captured generation. */
export function appiumRecordReplacement(record: Record<string, unknown>, replacement: Record<string, unknown> | null, updatedAt: string): Record<string, unknown> {
    return { ...record, appium: replacement,
        ...(typeof replacement?.port === "number" ? { appiumPort: replacement.port } : {}), updatedAt };
}
