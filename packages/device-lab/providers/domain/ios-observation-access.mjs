/** @param {unknown} error */
export function iosAccessErrorMessage(error) {
    return error !== null && typeof error === "object" && "message" in error ? String(error.message) : String(error);
}
/** @param {unknown} error */
export function iosAccessErrorCode(error) {
    return error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
}
/** @param {unknown} args */
export function iosExecInputError(args) {
    if (!args || typeof args !== "object" || Array.isArray(args)) return "exec arguments must be an object";
    const value = /** @type {{command?:unknown;argv?:unknown}} */ (args);
    const hasCommand = Object.hasOwn(value, "command");
    const hasArgv = Object.hasOwn(value, "argv");
    if (hasCommand === hasArgv) return "exec requires exactly one of command or argv";
    if (hasCommand) return typeof value.command === "string" && value.command.length <= 4096
        ? null : "exec command must be a string of at most 4096 characters";
    const argv = value.argv;
    if (!Array.isArray(argv) || argv.length < 1 || argv.length > 64) return "exec argv must contain 1 to 64 strings";
    let length = 0;
    for (const argument of argv) {
        if (typeof argument !== "string" || argument.length > 4096 || argument.includes("\0")) {
            return "exec argv elements must be strings of at most 4096 characters without NUL";
        }
        length += argument.length;
        if (length > 4096) return "exec argv must total at most 4096 characters";
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(argv[0])) return "exec argv program must be a basename without paths or leading options";
    return null;
}
/** @param {string} variant @param {string} tool */
export function iosAccessUnsupported(variant, tool) {
    if (tool === "device_exec") return `iOS real devices do not support ${tool} through base simctl; use Appium/XCUITest or Xcode device tooling where available.`;
    return variant === "physical"
        ? `iOS real devices do not support ${tool} through CCC because the action is unavailable or unsafe for physical devices.`
        : `iOS Simulator does not support ${tool} through base simctl; use Appium/XCUITest support when available.`;
}
