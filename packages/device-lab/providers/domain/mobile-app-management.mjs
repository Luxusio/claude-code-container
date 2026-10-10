/** Current app arguments after the existing public normalization boundary.
 * @typedef {object} MobileAppArguments
 * @property {string} [deviceId]
 * @property {string} [path]
 * @property {boolean} [replace]
 * @property {string} [packageName]
 * @property {string} [component]
 * @property {string} [bundleId]
 * @property {string} [permission]
 * @property {string} [service]
 * @property {string} [url]
 * @property {string} [containerType]
 * @property {unknown} [helperTimeoutMs]
 */
/** @typedef {'emulator'|'physical'} AndroidAppVariant */
/** @typedef {{status:number|null,stdout?:string,stderr?:string,error?:{message?:string},signal?:string|null}} MobileCommandReceipt */
/** @typedef {{provider:'adb'} & (
 * {installed:string|undefined}|{launched:string}|{stopped:string}|{uninstalled:string}
 * |{packageName:string}|{reset:{packageName:string}}|{openedUrl:string|undefined}
 * |{permission:{packageName:string,permission:string,action:'grant'|'revoke'}}
 * )} AndroidAppPayload */
/** @typedef {{ok:false,message:string}|{
 * ok:true,args:(string|undefined)[],payload:AndroidAppPayload,validateLaunch:boolean,helperTimeoutMs?:unknown
 * }} AndroidAppPlan */

/** A successful process exit can still carry an ADB launch refusal.
 * @param {MobileCommandReceipt} result
 */
export function adbLaunchSemanticFailure(result) {
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    return /(?:no activities found to run|monkey aborted|error:\s*(?:activity|unable to resolve intent)|activity class .* does not exist)/i.test(output);
}

/** Call after native guarded target selection, preserving refusal precedence.
 * @param {string} name
 * @param {MobileAppArguments} args
 * @param {AndroidAppVariant} variant
 * @returns {AndroidAppPlan|undefined}
 */
export function androidAppPlan(name, args, variant) {
    const { path, packageName, component, permission, url } = args;
    switch (name) {
        case "device_install_app":
        case "mobile_install_app": {
            const replace = name === "mobile_install_app" ? true : args.replace === undefined ? true : args.replace;
            return {
                ok: true, args: replace ? ["install", "-r", path] : ["install", path],
                payload: { installed: path, provider: "adb" }, validateLaunch: false, helperTimeoutMs: args.helperTimeoutMs,
            };
        }
        case "device_launch_app":
        case "mobile_launch_app":
            if (component) return { ok: true, args: ["shell", "am", "start", "-n", component], payload: { launched: component, provider: "adb" }, validateLaunch: true };
            if (!packageName) return { ok: false, message: "Android app launch requires packageName or component" };
            return { ok: true, args: ["shell", "monkey", "-p", packageName, "1"], payload: { launched: packageName, provider: "adb" }, validateLaunch: true };
        case "mobile_uninstall_app":
            if (!packageName) return { ok: false, message: "Android app uninstall requires packageName" };
            return { ok: true, args: ["uninstall", packageName], payload: { uninstalled: packageName, provider: "adb" }, validateLaunch: false };
        case "mobile_stop_app":
            if (!packageName) return { ok: false, message: variant === "physical" ? `Android ${name} requires packageName` : "Android app stop requires packageName" };
            return { ok: true, args: ["shell", "am", "force-stop", packageName], payload: variant === "physical" ? { packageName, provider: "adb" } : { stopped: packageName, provider: "adb" }, validateLaunch: false };
        case "device_reset":
        case "mobile_clear_app_data":
            if (!packageName) return { ok: false, message: name === "mobile_clear_app_data" && variant === "physical" ? `Android ${name} requires packageName` : "Android reset requires packageName to clear app data" };
            return { ok: true, args: ["shell", "pm", "clear", packageName], payload: name === "mobile_clear_app_data" && variant === "physical" ? { packageName, provider: "adb" } : { reset: { packageName }, provider: "adb" }, validateLaunch: false };
        case "mobile_grant_permission":
        case "mobile_revoke_permission": {
            if (!packageName || !permission) return { ok: false, message: `Android ${name} requires packageName and permission` };
            const action = name === "mobile_grant_permission" ? "grant" : "revoke";
            return { ok: true, args: ["shell", "pm", action, packageName, permission], payload: { permission: { packageName, permission, action }, provider: "adb" }, validateLaunch: false };
        }
        case "mobile_open_url":
            return { ok: true, args: ["shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", url], payload: { openedUrl: url, provider: "adb" }, validateLaunch: false };
        default:
            return undefined;
    }
}

/** @param {MobileCommandReceipt} result @param {boolean} validateLaunch */
export function androidAppCommandSucceeded(result, validateLaunch) {
    return result.status === 0 && (!validateLaunch || !adbLaunchSemanticFailure(result));
}

/** @param {string|undefined} value */
export function iosAppContainerType(value) {
    return value || "data";
}

/** @param {string} name */
export function physicalIosUnsupportedAppMessage(name) {
    return `iOS real devices do not support ${name} through CCC because the action is unavailable or unsafe for physical devices.`;
}
