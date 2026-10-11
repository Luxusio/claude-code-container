/** @param {unknown} response @returns {unknown} */
export function iosResponseValue(response) {
    if (response !== null && typeof response === "object" && "value" in response && response.value != null) return response.value;
    return response;
}
/** @param {unknown} response @returns {unknown} */
export function iosSourceValue(response) {
    if (response !== null && typeof response === "object") {
        if ("value" in response && response.value != null) return response.value;
        if ("source" in response && response.source != null) return response.source;
    }
    return response;
}
/** @param {unknown} response @returns {unknown} */
export function iosScreenshotData(response) {
    if (response === null || typeof response !== "object") return undefined;
    return ("value" in response && response.value) || ("screenshot" in response && response.screenshot) || undefined;
}
/** @param {unknown} response @returns {string|undefined} */
export function iosSessionId(response) {
    const value = iosResponseValue(response);
    if (value !== null && typeof value === "object" && "sessionId" in value && typeof value.sessionId === "string" && value.sessionId) return value.sessionId;
    if (response !== null && typeof response === "object" && "sessionId" in response && typeof response.sessionId === "string" && response.sessionId) return response.sessionId;
    return undefined;
}
/** @param {unknown} active @param {string} bundleId */
export function iosActiveAppMatches(active, bundleId) {
    return active !== null && typeof active === "object"
        && (("bundleId" in active && active.bundleId === bundleId) || ("bundleID" in active && active.bundleID === bundleId));
}
/** @param {{status:number|null,stdout:string,stderr:string,error?:unknown,signal?:unknown}} command */
export function iosCleanAppObservation(command) {
    return !command.error && !command.signal && (command.status === 0 || (command.status === 1 && !command.stdout && !command.stderr));
}
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
