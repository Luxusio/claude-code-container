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
/** @typedef {{setting:'level'|'status',value:number}|{setting:'charging',value:boolean}} BatterySetting */
/** @typedef {{setting:'wifi'|'data',enabled:boolean}} AndroidRadioSetting */

/** Network admission precedes native target lookup.
 * @param {EnvironmentArguments} args */
export function validAndroidNetwork(args) {
    const values = [args.airplaneMode, args.wifi, args.data];
    return values.some(value => value !== undefined)
        && values.every(value => value === undefined || typeof value === "boolean");
}

/** @param {EnvironmentArguments} args @returns {BatterySetting[]} */
export function androidBatterySettings(args) {
    /** @type {BatterySetting[]} */
    const commands = [];
    if (args.level !== undefined) commands.push({ setting: "level", value: args.level });
    if (args.status !== undefined) commands.push({ setting: "status", value: args.status });
    if (args.charging !== undefined) commands.push({ setting: "charging", value: args.charging });
    return commands;
}

/** @param {EnvironmentArguments} args @returns {AndroidRadioSetting[]} */
export function androidRadioSettings(args) {
    /** @type {AndroidRadioSetting[]} */
    const commands = [];
    if (args.wifi !== undefined) commands.push({ setting: "wifi", enabled: !!args.wifi });
    if (args.data !== undefined) commands.push({ setting: "data", enabled: !!args.data });
    return commands;
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
