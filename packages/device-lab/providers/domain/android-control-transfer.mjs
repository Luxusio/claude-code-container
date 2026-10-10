/** @typedef {'mobile_tap'|'mobile_double_tap'|'mobile_long_press'|'mobile_swipe'|'mobile_drag'|'mobile_type_text'|'mobile_key'|'mobile_back'|'mobile_home'|'mobile_forward'|'mobile_recents'|'mobile_power'|'mobile_lock'|'mobile_unlock'|'device_upload'|'device_download'} Operation */
/** @typedef {'emulator'|'physical'} Variant */
/** @typedef {object} Arguments
 * @property {unknown} [deviceId]
 * @property {unknown} [x]
 * @property {unknown} [y]
 * @property {unknown} [x1]
 * @property {unknown} [y1]
 * @property {unknown} [x2]
 * @property {unknown} [y2]
 * @property {unknown} [durationMs]
 * @property {unknown} [text]
 * @property {unknown} [key]
 * @property {unknown} [keyCode]
 * @property {unknown} [localPath]
 * @property {unknown} [remotePath]
 */
/** @typedef {{ x: unknown; y: unknown }} Point */
/** @typedef {{ x1: unknown; y1: unknown; x2: unknown; y2: unknown; durationMs: unknown }} Swipe */
/** @typedef {{ provider: 'adb' } & (
 * { tapped: Point } | { doubleTapped: Point } | { longPressed: Point & {durationMs:unknown} }
 * | { swiped: Swipe } | { dragged: Swipe } | { typed: true } | { key: unknown }
 * | { back: true } | { home: true } | { forward: true } | { recents: true }
 * | { power: true } | { locked: true } | { unlocked: true }
 * )} Payload */
/** @typedef {{ok:false;message:string}|{ok:true;args:string[];payload:Payload;doubleTap:boolean}} Plan */

/** @param {unknown} text */
export function androidControlText(text) {
    return String(text).replace(/\s/g, "%s");
}

/** @param {Operation} operation @param {Arguments} input @param {Variant} variant
 * @returns {Plan | undefined} */
export function androidActionPlan(operation, input, variant) {
    const { x, y, x1, y1, x2, y2 } = input;
    switch (operation) {
        case "mobile_tap":
        case "mobile_double_tap":
            return { ok: true, args: ["shell", "input", "tap", String(x), String(y)],
                payload: operation === "mobile_double_tap"
                    ? { doubleTapped: { x, y }, provider: "adb" }
                    : { tapped: { x, y }, provider: "adb" },
                doubleTap: operation === "mobile_double_tap" };
        case "mobile_long_press": {
            const { durationMs = 700 } = input;
            return { ok: true, args: ["shell", "input", "swipe", String(x), String(y), String(x), String(y), String(durationMs)],
                payload: { longPressed: { x, y, durationMs }, provider: "adb" }, doubleTap: false };
        }
        case "mobile_swipe":
        case "mobile_drag": {
            const { durationMs = operation === "mobile_drag" ? 700 : 300 } = input;
            return { ok: true, args: ["shell", "input", "swipe", String(x1), String(y1), String(x2), String(y2), String(durationMs)],
                payload: operation === "mobile_drag"
                    ? { dragged: { x1, y1, x2, y2, durationMs }, provider: "adb" }
                    : { swiped: { x1, y1, x2, y2, durationMs }, provider: "adb" }, doubleTap: false };
        }
        case "mobile_type_text":
            return { ok: true, args: ["shell", "input", "text", androidControlText(input.text)],
                payload: { typed: true, provider: "adb" }, doubleTap: false };
        case "mobile_key": {
            const key = input.keyCode ?? input.key;
            if (key === undefined || key === null || key === "") {
                return { ok: false, message: "mobile_key requires key or keyCode" };
            }
            return { ok: true, args: ["shell", "input", "keyevent", String(key)],
                payload: { key, provider: "adb" }, doubleTap: false };
        }
        case "mobile_back":
        case "mobile_home":
        case "mobile_forward":
        case "mobile_recents":
        case "mobile_power":
        case "mobile_lock":
        case "mobile_unlock": {
            const navigation = androidNavigation(operation);
            return { ok: true, args: ["shell", "input", "keyevent", String(navigation.key)],
                payload: variant === "physical" ? { key: navigation.key, provider: "adb" } : navigation.payload,
                doubleTap: false };
        }
        default:
            return undefined;
    }
}

/** @param {'mobile_back'|'mobile_home'|'mobile_forward'|'mobile_recents'|'mobile_power'|'mobile_lock'|'mobile_unlock'} operation
 * @returns {{ key: number; payload: Payload }} */
function androidNavigation(operation) {
    switch (operation) {
        case "mobile_back": return { key: 4, payload: { back: true, provider: "adb" } };
        case "mobile_home": return { key: 3, payload: { home: true, provider: "adb" } };
        case "mobile_forward": return { key: 125, payload: { forward: true, provider: "adb" } };
        case "mobile_recents": return { key: 187, payload: { recents: true, provider: "adb" } };
        case "mobile_power": return { key: 26, payload: { power: true, provider: "adb" } };
        case "mobile_lock": return { key: 223, payload: { locked: true, provider: "adb" } };
        case "mobile_unlock": return { key: 224, payload: { unlocked: true, provider: "adb" } };
    }
}
