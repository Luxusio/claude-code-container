/** @typedef {'mobile_tap'|'mobile_double_tap'|'mobile_long_press'|'mobile_swipe'|'mobile_drag'|'mobile_type_text'|'mobile_key'|'mobile_back'|'mobile_home'|'mobile_forward'|'mobile_recents'|'mobile_power'|'mobile_lock'|'mobile_unlock'|'mobile_set_orientation'|'mobile_rotate_left'|'mobile_rotate_right'|'device_upload'|'device_download'} Operation */
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
 * @property {unknown} [orientation]
 */
/** @typedef {{ x: unknown; y: unknown }} Point */
/** @typedef {{ x1: unknown; y1: unknown; x2: unknown; y2: unknown; durationMs: unknown }} Swipe */
/** @typedef {{orientation:unknown,rotation:"0"|"1"|"2"|"3",provider:"adb"}} OrientationPayload */
/** @typedef {{ provider: 'adb' } & (
 * { tapped: Point } | { doubleTapped: Point } | { longPressed: Point & {durationMs:unknown} }
 * | { swiped: Swipe } | { dragged: Swipe } | { typed: true } | { key: unknown }
 * | { back: true } | { home: true } | { forward: true } | { recents: true }
 * | { power: true } | { locked: true } | { unlocked: true } | OrientationPayload
 * )} Payload */
/** @typedef {{kind:"tap",point:Point}|{kind:"swipe",swipe:Swipe}|{kind:"text",text:unknown}|{kind:"key",key:unknown}} Intent */
/** @typedef {{ok:false;message:string}|{ok:true;intent:Intent;payload:Payload;doubleTap:boolean}} Plan */

/** @param {Operation} operation @param {Arguments} input @param {Variant} variant
 * @returns {Plan | undefined} */
export function androidActionPlan(operation, input, variant) {
    const { x, y, x1, y1, x2, y2 } = input;
    switch (operation) {
        case "mobile_tap":
        case "mobile_double_tap":
            return { ok: true, intent: {kind:"tap",point:{x,y}},
                payload: operation === "mobile_double_tap"
                    ? { doubleTapped: { x, y }, provider: "adb" }
                    : { tapped: { x, y }, provider: "adb" },
                doubleTap: operation === "mobile_double_tap" };
        case "mobile_long_press": {
            const { durationMs = 700 } = input;
            return { ok: true, intent: {kind:"swipe",swipe:{x1:x,y1:y,x2:x,y2:y,durationMs}},
                payload: { longPressed: { x, y, durationMs }, provider: "adb" }, doubleTap: false };
        }
        case "mobile_swipe":
        case "mobile_drag": {
            const { durationMs = operation === "mobile_drag" ? 700 : 300 } = input;
            return { ok: true, intent: {kind:"swipe",swipe:{x1,y1,x2,y2,durationMs}},
                payload: operation === "mobile_drag"
                    ? { dragged: { x1, y1, x2, y2, durationMs }, provider: "adb" }
                    : { swiped: { x1, y1, x2, y2, durationMs }, provider: "adb" }, doubleTap: false };
        }
        case "mobile_type_text":
            return { ok: true, intent: {kind:"text",text:input.text},
                payload: { typed: true, provider: "adb" }, doubleTap: false };
        case "mobile_key": {
            const key = input.keyCode ?? input.key;
            if (key === undefined || key === null || key === "") {
                return { ok: false, message: "mobile_key requires key or keyCode" };
            }
            return { ok: true, intent: {kind:"key",key},
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
            return { ok: true, intent: {kind:"key",key:navigation.key},
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

/** @param {Operation} operation @param {Arguments} input
 * @returns {{ok:false,message:string}|{ok:true,rotation:"0"|"1"|"2"|"3",payload:OrientationPayload}} */
export function androidOrientationPlan(operation, input) {
    const orientation = operation === "mobile_rotate_left" ? "landscape"
        : operation === "mobile_rotate_right" ? "reverse-landscape" : input.orientation;
    /** @type {"0"|"1"|"2"|"3"} */
    let rotation;
    switch (orientation) {
        case "portrait": rotation = "0"; break;
        case "landscape": rotation = "1"; break;
        case "reverse-portrait": rotation = "2"; break;
        case "reverse-landscape": rotation = "3"; break;
        default: return { ok: false, message: `Unsupported Android orientation: ${orientation}` };
    }
    return {
        ok: true,
        rotation,
        payload: { orientation, rotation, provider: "adb" },
    };
}
