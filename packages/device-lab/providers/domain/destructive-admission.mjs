/**
 * @typedef {{ok: true, destructive: false, actions: string[]} |
 * {ok: true, destructive: true, actions: string[]} |
 * {ok: false, destructive: true, error: "destructive-action-confirmation-required",
 * message: string, confirmationField: "confirmDestructive", actions: string[]}} DestructivePolicyResult
 */

const CONFIRM_DESTRUCTIVE_FIELD = "confirmDestructive";

/** @param {any} args */
function hasConfirmation(args) {
    return args?.[CONFIRM_DESTRUCTIVE_FIELD] === true;
}

/** @param {any} body */
function bodyScript(body) {
    return typeof body?.script === "string" ? body.script : "";
}

/** @param {any} body */
function bodyCommand(body) {
    const first = Array.isArray(body?.args) ? body.args[0] : null;
    return typeof first?.command === "string" ? first.command : "";
}

/** @param {any} body */
function bodyArgs(body) {
    const first = Array.isArray(body?.args) ? body.args[0] : null;
    return Array.isArray(first?.args) ? first.args.map(String) : [];
}

/** @param {any} args */
function classifyBrokerAppiumRequest(args) {
    const path = typeof args?.path === "string" ? args.path : "";
    const method = typeof args?.method === "string" ? args.method.toUpperCase() : "";
    const body = args?.body || {};
    const reasons = [];

    if (args?.force === true && ["clear", "stop"].includes(args?.action)) {
        reasons.push("broker-appium-force-lifecycle");
    }

    if (args?.action !== "request") return reasons;

    if (method === "POST" && path.includes("/appium/device/remove_app")) {
        reasons.push("app-uninstall");
    }

    if (method === "POST" && bodyScript(body) === "mobile: shell") {
        const command = bodyCommand(body);
        const argv = bodyArgs(body);
        if (command === "pm" && argv[0] === "clear" && argv[1]) reasons.push("app-data-clear");
        if (command === "svc" && ["wifi", "data"].includes(argv[0])) reasons.push("device-network-change");
        if (command === "cmd" && argv.includes("battery")) reasons.push("device-system-change");
        if (command === "settings" && argv.includes("airplane_mode_on")) reasons.push("device-network-change");
        if (command === "am" && argv[0] === "broadcast" && argv.includes("android.intent.action.AIRPLANE_MODE")) reasons.push("device-network-change");
    }

    return reasons;
}

/** @param {unknown} name @param {any} args */
function classify(name, args = {}) {
    switch (name) {
        case "device_delete": {
            const reasons = ["device-delete"];
            if (args.force === true) reasons.push("force-delete");
            if (args.deleteAvd === true) reasons.push("delete-avd");
            if (args.deleteSimulator === true) reasons.push("delete-simulator");
            return reasons;
        }
        case "device_reset":
            return [args.eraseSimulator === true ? "erase-simulator" : "app-data-clear"];
        case "device_snapshot_restore":
            return ["snapshot-restore"];
        case "device_snapshot_delete":
            return ["snapshot-delete"];
        case "device_broker_shutdown":
            return ["broker-shutdown"];
        case "mobile_uninstall_app":
            return ["app-uninstall"];
        case "mobile_clear_app_data":
            return ["app-data-clear"];
        case "mobile_set_battery":
            return ["device-system-change"];
        case "mobile_set_network":
        case "mobile_toggle_airplane_mode":
            return ["device-network-change"];
        case "device_broker_command":
            if (args.action === "invoke" && args.command === "device_delete") {
                return ["broker-device-delete"];
            }
            return [];
        case "device_broker_appium":
            return classifyBrokerAppiumRequest(args);
        default:
            return [];
    }
}

/**
 * Authorize the existing destructive action without observing native state.
 * Inputs deliberately retain the legacy JavaScript property/coercion behavior.
 * @param {unknown} name
 * @param {any} args
 * @returns {DestructivePolicyResult}
 */
export function evaluateDestructivePolicy(name, args = {}) {
    const actions = [...new Set(classify(name, args))];
    if (actions.length === 0) return { ok: true, destructive: false, actions: [] };
    if (hasConfirmation(args)) return { ok: true, destructive: true, actions };
    return {
        ok: false,
        destructive: true,
        error: "destructive-action-confirmation-required",
        message: `Set ${CONFIRM_DESTRUCTIVE_FIELD}=true to run this destructive device-lab action.`,
        confirmationField: CONFIRM_DESTRUCTIVE_FIELD,
        actions,
    };
}
