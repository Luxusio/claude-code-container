/** @typedef {object} EnvironmentArguments
 * @property {string} [deviceId]
 * @property {number} [latitude]
 * @property {number} [longitude]
 * @property {number} [altitude]
 * @property {number} [level]
 * @property {number} [status]
 * @property {boolean} [charging]
 * @property {unknown} [wifi]
 * @property {unknown} [data]
 * @property {unknown} [airplaneMode]
 * @property {boolean} [enabled]
 * @property {unknown} [text]
 */
/** @typedef {'mobile_set_location'|'mobile_set_battery'|'mobile_set_network'|'mobile_toggle_airplane_mode'|'mobile_set_clipboard'|'mobile_get_clipboard'} EnvironmentOperation */
/** @typedef {{setting:'wifi'|'data',args:string[]}} AndroidRadioCommand */

/** Network admission precedes native target lookup.
 * @param {EnvironmentArguments} args */
export function validAndroidNetwork(args) {
    const values = [args.airplaneMode, args.wifi, args.data];
    return values.some(value => value !== undefined)
        && values.every(value => value === undefined || typeof value === "boolean");
}

/** @param {EnvironmentArguments} args @returns {string[][]} */
export function androidBatteryCommands(args) {
    const commands = [];
    if (args.level !== undefined) commands.push(["shell", "dumpsys", "battery", "set", "level", String(args.level)]);
    if (args.status !== undefined) commands.push(["shell", "dumpsys", "battery", "set", "status", String(args.status)]);
    if (args.charging !== undefined) commands.push(["shell", "dumpsys", "battery", "set", "ac", args.charging ? "1" : "0"]);
    return commands;
}

/** @param {EnvironmentArguments} args @returns {AndroidRadioCommand[]} */
export function androidRadioCommands(args) {
    /** @type {AndroidRadioCommand[]} */
    const commands = [];
    if (args.wifi !== undefined) commands.push({ setting: "wifi", args: ["shell", "svc", "wifi", args.wifi ? "enable" : "disable"] });
    if (args.data !== undefined) commands.push({ setting: "data", args: ["shell", "svc", "data", args.data ? "enable" : "disable"] });
    return commands;
}

/** Individual commands only; fallback sequencing belongs to the application.
 * @param {unknown} enabled */
export function androidAirplaneCommands(enabled) {
    return {
        modern: ["shell", "cmd", "connectivity", "airplane-mode", enabled ? "enable" : "disable"],
        setting: ["shell", "settings", "put", "global", "airplane_mode_on", enabled ? "1" : "0"],
        broadcast: ["shell", "am", "broadcast", "-a", "android.intent.action.AIRPLANE_MODE", "--ez", "state", enabled ? "true" : "false"]
    };
}

/** Serial qualification remains native; preserve longitude before latitude.
 * @param {EnvironmentArguments} args */
export function androidGeoArguments(args) {
    const command = ["emu", "geo", "fix", String(args.longitude), String(args.latitude)];
    if (args.altitude !== undefined) command.push(String(args.altitude));
    return command;
}

/** @param {string} name @param {string} target @param {EnvironmentArguments} args
 * @returns {{args:string[],input?:string}|undefined} */
export function iosEnvironmentCommand(name, target, args) {
    switch (name) {
        case "mobile_set_location":
            return { args: ["simctl", "location", target, "set", `${args.latitude},${args.longitude}`] };
        case "mobile_set_clipboard":
            return { args: ["simctl", "pbcopy", target], input: String(args.text) };
        case "mobile_get_clipboard":
            return { args: ["simctl", "pbpaste", target] };
        default:
            return undefined;
    }
}

/** @param {'android-physical'|'ios-simulator'|'ios-physical'} variant @param {string} name */
export function environmentUnsupportedMessage(variant, name) {
    if (variant === "android-physical") {
        return `Android real devices do not support ${name} safely through the base ADB layer; use an emulator or a dedicated device-farm controller.`;
    }
    if (variant === "ios-simulator") {
        return `iOS Simulator does not support ${name} through base simctl; use Appium/XCUITest support when available.`;
    }
    return `iOS real devices do not support ${name} through CCC because the action is unavailable or unsafe for physical devices.`;
}
