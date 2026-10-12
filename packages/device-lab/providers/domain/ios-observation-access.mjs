/** @param {unknown} error */
export function iosAccessErrorMessage(error) {
    return error !== null && typeof error === "object" && "message" in error ? String(error.message) : String(error);
}
/** @param {unknown} error */
export function iosAccessErrorCode(error) {
    return error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
}
/** @param {string} variant @param {string} tool */
export function iosAccessUnsupported(variant, tool) {
    if (tool === "device_exec") return `iOS real devices do not support ${tool} through base simctl; use Appium/XCUITest or Xcode device tooling where available.`;
    return variant === "physical"
        ? `iOS real devices do not support ${tool} through CCC because the action is unavailable or unsafe for physical devices.`
        : `iOS Simulator does not support ${tool} through base simctl; use Appium/XCUITest support when available.`;
}
