import { TOOLS } from "./operation-tools.mjs";

const TOOL_NAMES = new Set(TOOLS.map((tool) => tool.name));

// Presentation only: provider contracts and opaque user payloads stay untouched.
function object(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function omit(value, keys) {
    const result = { ...value };
    for (const key of keys) delete result[key];
    return result;
}

function failed(value) {
    return object(value) && (value.ok === false || value.isError === true || Boolean(value.error));
}

function internalStatus(value) {
    if (!object(value) || failed(value)) return value;
    // These objects are generated helper/session metadata, never artifact results.
    return Object.fromEntries(Object.entries(value).filter(([key, item]) =>
        item !== null && !/^(?:ownerId|createdAt|updatedAt|serverPid|pid|serverUrl|serverPort|appiumPort|requiredFor)$/.test(key)
        && !/(?:Path|Dir|Script|Root)$/.test(key)));
}

function recordingStatus(value) {
    if (!object(value) || failed(value)) return value;
    return omit(value, ["pid", "processIdentity", "processStartToken", "processOwner", "startedBy", "ownerId", "createdAt", "updatedAt"]);
}

function automationStatus(value) {
    if (!object(value) || failed(value)) return value;
    const result = omit(value, ["lazy", "tools"]);
    if (object(result.appium) && !failed(result.appium)) {
        result.appium = omit(result.appium, ["appium", "adb", "xcrun", "xcodebuild", "xcuitestDriver", "tools"]);
    }
    if (object(result.session) && !failed(result.session)) {
        result.session = omit(internalStatus(result.session), ["processIdentity", "processOwner", "startedBy"]);
    }
    return result;
}

function qemuRecord(value) {
    return object(value) && value.provider === "container-qemu" && typeof value.id === "string"
        && (typeof value.runtimeState === "string" || value.targetKind === "lab-vm");
}

function sameValue(left, right) {
    return left !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

// Only remove successful observations already represented in this response.
// Unique history (including artifact destinations) and unknown records stay intact.
function qemuHistory(entries, current, successful, same = sameValue) {
    return entries.filter((entry, index) => !successful(entry)
        || !((successful(current) && same(entry, current))
            || entries.slice(0, index).some((prior) => successful(prior) && same(entry, prior))));
}

function qemuTarget(value) {
    if (!qemuRecord(value) || failed(value)) return value;
    const result = { ...value };
    if (object(result.paths)) result.paths = omit(result.paths, ["labDir", "snapshotsDir"]);
    if (object(result.runtime) && !failed(result.runtime)) result.runtime = omit(result.runtime, ["pid", "command", "args", "processIdentity"]);
    if (object(result.readiness) && !failed(result.readiness) && Array.isArray(result.readiness.history)) {
        const successful = (entry) => object(entry) && !failed(entry) && ["ready", "process-running", "stopped"].includes(entry.state)
            && Object.keys(entry).every((key) => ["id", "labId", "targetId", "provider", "state", "checkedAt", "checks", "diagnostics"].includes(key))
            && Array.isArray(entry.checks) && entry.checks.every((check) => object(check) && !failed(check)
                && ["pass", "skipped"].includes(check.status)
                && Object.keys(check).every((key) => ["name", "status", "pid", "reason"].includes(key)))
            && sameValue(entry.diagnostics, { kind: "process-only" });
        result.readiness = { ...result.readiness, history: qemuHistory(result.readiness.history, result.readiness.latest,
            successful, (left, right) => sameValue(omit(left, ["id", "checkedAt"]), omit(right, ["id", "checkedAt"]))) };
        if (!result.readiness.history.length) delete result.readiness.history;
    }
    if (Array.isArray(result.fileOperations) && !result.fileOperations.length) delete result.fileOperations;
    return result;
}

function qemuOperation(value) {
    if (!object(value) || failed(value) || !qemuRecord(value.lab || value.device)) return value;
    const result = omit(value, ["ownerId"]);
    if (object(value.lab)) result.lab = target(value.lab);
    if (object(value.device)) result.device = target(value.device);
    if (object(value.target)) result.target = target(value.target);
    for (const key of ["start", "stop", "materialized"]) {
        if (object(value[key])) result[key] = qemuOperation(value[key]);
    }
    // Successful launch/materialization command wiring is not a user exec result.
    // Dry-run plans and every nonempty diagnostic remain reviewable.
    for (const key of ["started", ...(value.materialized === true && typeof value.diskImage === "string" ? ["result"] : [])]) {
        if (!object(value[key]) || value[key].ok !== true || failed(value[key])) continue;
        result[key] = omit(value[key], ["pid", "processIdentity", "command", "args"]);
        for (const stream of ["stdout", "stderr"]) if (result[key][stream] === "") delete result[key][stream];
        if (result[key].status === 0) delete result[key].status;
    }
    for (const key of ["lab", "device"]) {
        if (!qemuRecord(value[key]) || failed(value[key]) || !Array.isArray(value[key].sessions)) continue;
        result[key] = { ...result[key], sessions: qemuHistory(value[key].sessions, value.session,
            (entry) => object(entry) && !failed(entry) && entry.state === "open") };
        if (!result[key].sessions.length) delete result[key].sessions;
    }
    return result;
}

function target(value, options = {}) {
    if (!object(value) || failed(value)) return value;
    value = qemuTarget(value);
    const result = omit(value, ["ownerId", "stateRoot", "ownerRoot", "stateDir", "metadataPath", "runtimeFile", "avdRoot", "incarnationId", "createdAt", "updatedAt", "pid", "appiumPort"]);
    // Remove only values also represented at the target's top level.
    if (object(value.targetStatus)) {
        const remaining = Object.fromEntries(Object.entries(value.targetStatus).filter(([key, item]) => JSON.stringify(item) !== JSON.stringify(value[key])));
        if (Object.keys(remaining).length) result.targetStatus = remaining;
        else delete result.targetStatus;
    }
    for (const key of ["helper", "appium", "runtime", "sessionState"]) {
        if (object(result[key])) result[key] = internalStatus(result[key]);
    }
    if (object(result.sessionState)) {
        for (const key of ["helper", "appium"]) {
            if (object(result.sessionState[key])) result.sessionState[key] = internalStatus(result.sessionState[key]);
        }
        if (result.sessionState.state === "none" && Object.keys(result.sessionState).length === 1) delete result.sessionState;
    }
    if (object(result.recording)) result.recording = recordingStatus(result.recording);
    if (options.compactPlan === true && object(result.providerPlan) && !failed(result.providerPlan)) {
        result.providerPlan = omit(result.providerPlan, ["providerCommand", "workspaceDir", "startCommand", "stopCommand", "deleteCommand", "implemented"]);
        if (object(result.providerPlan.helper)) result.providerPlan.helper = internalStatus(result.providerPlan.helper);
        for (const key of ["image", "memoryMb", "cpus", "providerInstance"]) {
            if (JSON.stringify(result.providerPlan[key]) === JSON.stringify(result[key])) delete result.providerPlan[key];
        }
        if (Array.isArray(result.providerPlan.deferred) && !result.providerPlan.deferred.length) delete result.providerPlan.deferred;
    }
    if (result.leaseState?.state === "not-required") delete result.leaseState;
    if (result.runtimeState === result.status || result.runtimeState === result.lifecycle) delete result.runtimeState;
    for (const key of Object.keys(result)) if (result[key] === null) delete result[key];
    return result;
}

function backend(value) {
    if (!object(value)) return value;
    const result = omit(value, ["lazy", "ownerId", "stateRoot", "ownerRoot"]);
    if (object(result.tools)) delete result.tools;
    if (Array.isArray(result.missing) && !result.missing.length) delete result.missing;
    if (result.available === true && result.status === "available") delete result.status;
    if (result.readiness?.ok === true && result.readiness?.available === true) {
        result.readiness = omit(result.readiness, ["platform", "totalMemoryMb", "freeMemoryMb", "logicalProcessors", "qemuImgSignatureStatus"]);
        for (const key of ["ok", "available", "moduleAvailable", "hypervisorPresent", "vmmsRunning", "hyperVAdministratorsMember", "managementAccess", "qemuImgAvailable", "qemuImgTrusted"]) {
            if (result.readiness[key] === true) delete result.readiness[key];
        }
        for (const key of ["rebootPending", "sessionRefreshRequired"]) {
            if (result.readiness[key] === false) delete result.readiness[key];
        }
        for (const key of ["missing", "linuxImageMissing"]) {
            if (Array.isArray(result.readiness[key]) && result.readiness[key].length === 0) delete result.readiness[key];
        }
        if (!Object.keys(result.readiness).length) delete result.readiness;
    }
    return result;
}

function transportFailure(value) {
    const result = omit(value, ["routedBy", "ownerId", "runtime", "selected", "attempts", "launch"]);
    const same = (a, b) => a !== undefined && JSON.stringify(a) === JSON.stringify(b);
    const trace = (entry) => {
        if (!object(entry)) return entry;
        if ((entry.reason === "broker-reuse-process-verified" && entry.processVerification?.ok === true)
            || (entry.reason === "broker-owner-resolve-ready" && entry.ownerResolve?.ok === true)
            || (entry.ok === true && entry.body?.ok === true && entry.body?.name === "ccc-device-broker" && entry.endpoint?.endsWith("/health"))) return {};
        let compact = omit(entry, ["host", "port", "endpoint", "durationMs", "timeoutMs", "runtime", "ownerId", "launched", "reused"]);
        if (Array.isArray(compact.attempts) || object(compact.selected) || object(compact.launch)) compact = transportFailure(compact);
        if (same(compact.body, value.body) || same(compact.body, value.result)) delete compact.body;
        else if (object(compact.body) && same(compact.body.result, value.result)) compact.body = omit(compact.body, ["result"]);
        for (const key of ["ok", "error", "status", "detail", "remedy"]) {
            if (same(compact[key], value[key])) delete compact[key];
        }
        return compact;
    };
    if (object(value.body) && same(value.body.result, value.result)) result.body = omit(value.body, ["result"]);
    if (object(value.selected)) {
        const selected = trace(value.selected);
        if (Object.keys(selected).length) result.selected = selected;
    }
    if (object(value.launch)) {
        const launch = trace(value.launch);
        if (launch.ok === true) delete launch.ok;
        if (Object.keys(launch).length) result.launch = launch;
    }
    if (Array.isArray(value.attempts)) {
        const attempts = value.attempts.map(trace).filter((entry) =>
            !object(entry) || (Object.keys(entry).length && !same(entry, result.selected)));
        const unique = attempts.filter((entry, index) => attempts.findIndex((other) => same(entry, other)) === index);
        if (unique.length) result.attempts = unique;
    }
    return result;
}

function brokerStatus(value) {
    if (!object(value)) return value;
    const result = omit(value, ["ownerId", "lazy", "startupPolicy", "transport", "probe", "ownerResolve", "launch", "runtime", "state", "containerContract", "persistence", "implemented", "deferred", "note"]);
    const selected = value.probe?.selected;
    if (selected?.host && selected?.port) result.endpoint = `http://${selected.host}:${selected.port}`;
    for (const key of ["warnings", "remedies"]) {
        if (Array.isArray(result[key]) && result[key].length === 0) delete result[key];
    }
    // Failure details are useful even when no health endpoint was reachable.
    for (const key of ["launch", "ownerResolve"]) {
        if (failed(value[key])) result[key] = transportFailure(value[key]);
    }
    return result;
}

const TEXT_ACTIONS = new Set(["display_type", "device_type", "mobile_type_text"]);
const HELPER_ACTIONS = new Set([
    "device_click", "device_double_click", "device_key", "device_type", "device_scroll",
    "device_cursor_position", "device_window_list", "device_accessibility_snapshot",
    "device_upload", "device_download", "device_record_video_start", "device_record_video_stop",
    "device_record_video_status",
]);
const HELPER_ECHO_KEYS = new Set(["id", "type", "ok", "provider", "createdAt", "completedAt", "durationMs"]);

function withoutEcho(value, result) {
    const remaining = {};
    for (const [key, item] of Object.entries(value)) {
        if (HELPER_ECHO_KEYS.has(key) || item === null) continue;
        if (key in result && JSON.stringify(item) === JSON.stringify(result[key])) continue;
        remaining[key] = item;
    }
    return remaining;
}

function operationResult(name, value) {
    const result = name === "device_accessibility_snapshot" || name === "mobile_dump_ui"
        ? { ...value } : omit(value, ["incarnationId"]);
    // These are command diagnostics, not guest command output (device_exec is
    // excluded by project). Nonempty unique diagnostics remain available.
    if (result.stdout === "") delete result.stdout;
    if (result.stderr === "") delete result.stderr;
    if (result.status === 0) delete result.status;
    const helper = HELPER_ACTIONS.has(name)
        && (object(result.response) || typeof result.remoteScriptPath === "string");
    if (helper) {
        if (typeof result.stdout === "string") {
            try {
                const parsed = JSON.parse(result.stdout);
                if (object(parsed) && !failed(parsed)
                    && (JSON.stringify(parsed) === JSON.stringify(result.response)
                        || Object.keys(withoutEcho(parsed, result)).length === 0)) delete result.stdout;
            } catch { /* Keep non-JSON command diagnostics. */ }
        }
        if (object(result.response) && !failed(result.response)) {
            const remaining = withoutEcho(result.response, result);
            if (Object.keys(remaining).length) result.response = remaining;
            else delete result.response;
        }
        delete result.remoteScriptPath;
    }
    if (TEXT_ACTIONS.has(name)) {
        const text = typeof result.typed?.text === "string" ? result.typed.text
            : typeof result.text === "string" ? result.text : null;
        if (text !== null) {
            result.typed = true;
            result.length = text.length;
            delete result.text;
            delete result.keys;
        }
    }
    if (name === "mobile_session_status") return automationStatus(result);
    if (name === "mobile_get_clipboard" && typeof result.text === "string" && result.stdout === result.text) delete result.stdout;
    if (["device_record_video_start", "device_record_video_stop", "device_record_video_status"].includes(name)) {
        if (object(result.recording)) result.recording = recordingStatus(result.recording);
        if (object(result.helper) && !failed(result.helper) && object(result.recording)) {
            const remaining = Object.fromEntries(Object.entries(result.helper).filter(([key, item]) =>
                JSON.stringify(item) !== JSON.stringify(value.recording[key])));
            if (Object.keys(remaining).length) result.helper = remaining;
            else delete result.helper;
        }
    }
    if (name === "mobile_wait_for_text") delete result.source;
    if (name === "mobile_dump_ui" && typeof result.source === "string") {
        delete result.remotePath;
        delete result.serverUrl;
    }
    if (name === "mobile_set_battery" && Array.isArray(result.results)) {
        // Each command can fail independently; retain all nonempty diagnostics.
        const commands = result.results.map((entry) => object(entry) && !failed(entry)
            ? Object.fromEntries(Object.entries(entry).filter(([key, item]) =>
                !((key === "stdout" || key === "stderr") && item === "") && !(key === "status" && item === 0)))
            : entry);
        if (commands.every((entry) => object(entry) && !Object.keys(entry).length)) delete result.results;
        else result.results = commands;
    }
    if (["display_cursor_position", "device_cursor_position"].includes(name)
        && ("x" in result || object(result.cursor))) delete result.raw;
    return result;
}

export function compactToolValue(name, value) {
    if (!object(value) || !TOOL_NAMES.has(name) || name === "device_exec") return value;
    if (name === "device_run_flow") {
        if (!Array.isArray(value.results)) return value;
        return { ...value, results: value.results.map((step) => {
            if (!object(step) || !Array.isArray(step.content)) return step;
            return { ...step, content: step.content.map((item) => item.type === "json"
                ? { ...item, value: compactToolValue(step.tool, item.value) } : item) };
        }) };
    }
    // Explicit raw transport diagnostics are opaque, including their result keys.
    if (name?.startsWith("device_broker_") && name !== "device_broker_status") return value;
    if (name === "device_broker_status") return brokerStatus(value);
    if (!name?.startsWith("device_") && !name?.startsWith("mobile_") && !name?.startsWith("display_")) return value;
    // Keep complete failure and containment evidence, including nested provider errors.
    if (failed(value)) {
        const brokerFailure = typeof value.method === "string"
            && ("selected" in value || Array.isArray(value.attempts) || object(value.launch));
        return brokerFailure ? transportFailure(value) : omit(value, ["routedBy"]);
    }
    value = qemuOperation(value);
    if (value.ok === true && value.backend === "linux-vm"
        && ((name === "device_image_list" && Array.isArray(value.images))
            || (name === "device_image_import" && object(value.image)))) {
        const image = (entry) => object(entry) && !failed(entry)
            && entry.provider === "container-qemu" && typeof entry.id === "string" && typeof entry.format === "string"
            ? omit(entry, ["ownerId", "createdAt", "updatedAt"]) : entry;
        const result = omit(value, ["ownerId"]);
        if (name === "device_image_list") result.images = value.images.map(image);
        else result.image = image(value.image);
        return result;
    }
    value = operationResult(name, value);
    if (["device_accessibility_snapshot", "mobile_dump_ui"].includes(name) && value.provider !== "broker-appium") return value;
    if (name === "display_current") return target(value);
    const known = "routedBy" in value || "device" in value || "devices" in value
        || "targetStatus" in value || Array.isArray(value.targets) || (["device_backends", "device_inventory"].includes(name) && Array.isArray(value.backends))
        || (name === "device_status" && typeof value.id === "string")
        || (value.provider === "broker-appium" && object(value.broker));
    if (!known) return value;
    let result = omit(value, ["routedBy", "ownerId"]);
    if (name === "device_backends") {
        delete result.hostBackends;
        delete result.localBackends;
        delete result.source;
        if (Array.isArray(value.backends)) result.backends = value.backends.map(backend);
        if (object(value.broker)) result.broker = brokerStatus(value.broker);
    }
    if (object(value.device)) {
        result.device = target(value.device, { compactPlan: name === "device_status" });
        // The Linux adapter adds device fields to the same public lab value.
        // Remove the alias only when every lab field is represented exactly.
        if (object(value.lab) && Object.entries(value.lab).every(([key, item]) =>
            JSON.stringify(item) === JSON.stringify(value.device[key]))) delete result.lab;
    }
    if (Array.isArray(value.devices)) {
        result.devices = value.devices.map((device) => target(device, { compactPlan: name === "device_list" || name === "device_inventory" }));
        if (Array.isArray(value.labs) && value.labs.length === value.devices.length
            && value.labs.every((lab, index) => object(lab) && object(value.devices[index])
                && Object.entries(lab).every(([key, item]) => JSON.stringify(item) === JSON.stringify(value.devices[index][key])))) delete result.labs;
    }
    if (object(value.target)) result.target = target(value.target, { compactPlan: name === "device_status" });
    if (Array.isArray(value.targets)) result.targets = value.targets.map(target);
    if (object(value.targetStatus) || (name === "device_status" && typeof value.id === "string")) result = target(result, { compactPlan: name === "device_status" });
    if (object(value.backend)) result.backend = backend(value.backend);
    if (name === "device_status" && object(value.automation)) result.automation = automationStatus(value.automation);
    if (name === "device_status" && object(value.appium)) result.appium = automationStatus(value.appium);
    if (name === "device_inventory" && object(value.discovery) && !failed(value.discovery)) {
        result.discovery = omit(value.discovery, ["adb", "emulator", "avdmanager", "xcrun", "xcodebuild", "powershell", "ssh", "scp"]);
        if (value.backend === "linux-vm" && value.discovery.provider === "container-qemu" && !failed(value.discovery)) {
            result.discovery = omit(result.discovery, ["ownerId", "stateRoot", "qemu", "qemuImg"]);
        }
        if (value.backend === "windows-sandbox" && object(value.hostSandboxes) && !failed(value.hostSandboxes)) {
            result.discovery = omit(result.discovery, ["wsb"]);
            result.hostSandboxes = omit(value.hostSandboxes, ["command", "lazy"]);
            for (const key of ["available", "missing"]) {
                if (sameValue(value.hostSandboxes[key], value.discovery[key])) delete result.hostSandboxes[key];
            }
        }
        if (value.backend === "macos-vm" && Array.isArray(value.discovery.providers)) {
            const providers = (entries) => entries.map((entry) => object(entry) && !failed(entry) && typeof entry.name === "string"
                ? omit(entry, ["command"]) : entry);
            result.discovery.providers = providers(value.discovery.providers);
            if (object(value.hostVms) && !failed(value.hostVms)) {
                result.hostVms = omit(value.hostVms, ["lazy"]);
                if (Array.isArray(value.hostVms.providers)) result.hostVms.providers = providers(value.hostVms.providers);
                for (const key of ["available", "missing", "providers"]) {
                    if (sameValue(result.hostVms[key], result.discovery[key])) delete result.hostVms[key];
                }
            }
        }
    }
    if (name === "device_inventory" && Array.isArray(value.backends)) {
        result.backends = value.backends.map((entry) => object(entry)
            ? { ...backend(entry), ...(Array.isArray(entry.devices) ? { devices: entry.devices.map((device) => target(device, { compactPlan: true })) } : {}) }
            : entry);
    }
    // Known broker RPC envelope. Do not descend into exec output or arbitrary RPC values.
    if (object(value.result) && "routedBy" in value && name !== "device_exec") {
        result.result = compactToolValue(name, value.result);
    }
    if (value.provider === "broker-appium" && object(value.broker) && value.broker.ok === true) {
        const response = value.broker.result?.response;
        if (!failed(value.broker.result) && !failed(response) && !failed(response?.body) && !failed(response?.body?.value) && !(response?.status >= 400)) {
            delete result.broker;
            delete result.requests;
            // Preserve unique Appium return values when no public field represents them.
            const body = response?.body;
            const payload = object(body) && "value" in body ? body.value : body;
            if (payload !== undefined && payload !== null && !["mobile_dump_ui", "mobile_get_clipboard", "mobile_wait_for_app", "mobile_wait_for_text"].includes(name)) result.value = payload;
            if (result.ok === undefined) result.ok = true;
        }
    }
    return result;
}

export function compactToolResult(name, result) {
    if (!Array.isArray(result?.content)) return result;
    return { ...result, content: result.content.map((item) => {
        if (item.type !== "text" || typeof item.text !== "string") return item;
        try {
            return { ...item, text: JSON.stringify(compactToolValue(name, JSON.parse(item.text))) };
        } catch {
            return item;
        }
    }) };
}
