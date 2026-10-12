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
/** @typedef {{kind:'install',path:string|undefined,replace:boolean,helperTimeoutMs?:unknown}
 * |{kind:'launch-component',component:string}
 * |{kind:'launch-package',packageName:string}
 * |{kind:'uninstall',packageName:string}
 * |{kind:'stop',packageName:string}
 * |{kind:'clear-data',packageName:string}
 * |{kind:'permission',packageName:string,permission:string,action:'grant'|'revoke'}
 * |{kind:'open-url',url:string|undefined}
 * } AndroidAppEffect */
/** @typedef {{ok:false,message:string}|{ok:true,effect:AndroidAppEffect}} AndroidAppPlan */

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
                ok: true, effect: { kind: "install", path, replace, helperTimeoutMs: args.helperTimeoutMs },
            };
        }
        case "device_launch_app":
        case "mobile_launch_app":
            if (component) return { ok: true, effect: { kind: "launch-component", component } };
            if (!packageName) return { ok: false, message: "Android app launch requires packageName or component" };
            return { ok: true, effect: { kind: "launch-package", packageName } };
        case "mobile_uninstall_app":
            if (!packageName) return { ok: false, message: "Android app uninstall requires packageName" };
            return { ok: true, effect: { kind: "uninstall", packageName } };
        case "mobile_stop_app":
            if (!packageName) return { ok: false, message: variant === "physical" ? `Android ${name} requires packageName` : "Android app stop requires packageName" };
            return { ok: true, effect: { kind: "stop", packageName } };
        case "device_reset":
        case "mobile_clear_app_data":
            if (!packageName) return { ok: false, message: name === "mobile_clear_app_data" && variant === "physical" ? `Android ${name} requires packageName` : "Android reset requires packageName to clear app data" };
            return { ok: true, effect: { kind: "clear-data", packageName } };
        case "mobile_grant_permission":
        case "mobile_revoke_permission": {
            if (!packageName || !permission) return { ok: false, message: `Android ${name} requires packageName and permission` };
            const action = name === "mobile_grant_permission" ? "grant" : "revoke";
            return { ok: true, effect: { kind: "permission", packageName, permission, action } };
        }
        case "mobile_open_url":
            return { ok: true, effect: { kind: "open-url", url } };
        default:
            return undefined;
    }
}

/** @param {string|undefined} value */
export function iosAppContainerType(value) {
    return value || "data";
}

/** @param {string} name */
export function physicalIosUnsupportedAppMessage(name) {
    return `iOS real devices do not support ${name} through CCC because the action is unavailable or unsafe for physical devices.`;
}

/** @typedef {{kind:'install',path:string|undefined}
 * |{kind:'launch',bundleId:string|undefined}
 * |{kind:'stop',bundleId:string}
 * |{kind:'uninstall',bundleId:string}
 * |{kind:'permission',bundleId:string,service:string,action:'grant'|'revoke'}
 * |{kind:'open-url',url:string|undefined}
 * } IosSimulatorAppEffect */
/** @typedef {{kind:'install',path:string}|{kind:'launch',bundleId:string}} IosPhysicalAppEffect */
