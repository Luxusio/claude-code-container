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
/** @typedef {'back'|'home'|'forward'|'recents'|'power'|'lock'|'unlock'} Navigation */
/** @typedef {'portrait'|'landscape'|'reverse-portrait'|'reverse-landscape'} Orientation */
/** @typedef {{kind:'tapped'|'double-tapped';point:Point}|{kind:'long-pressed';point:Point;durationMs:unknown}
 * |{kind:'swiped'|'dragged';swipe:Swipe}|{kind:'typed'}|{kind:'key';key:unknown}|{kind:'navigation';navigation:Navigation}} ActionCompletion */
/** @typedef {ActionCompletion|{kind:'oriented';orientation:Orientation}
 * |{kind:'uploaded';localPath:string;remotePath:string}|{kind:'downloaded';remotePath:string;localPath:string}} Completion */
/** @typedef {{kind:"tap",point:Point}|{kind:"swipe",swipe:Swipe}|{kind:"text",text:unknown}|{kind:"key",key:unknown}|{kind:'navigation';navigation:Navigation}} Intent */
/** @typedef {{ok:false;message:string}|{ok:true;intent:Intent;completion:ActionCompletion;doubleTap:boolean}} Plan */

/** @param {Operation} operation @param {Arguments} input
 * @returns {Plan | undefined} */
export function androidActionPlan(operation, input) {
    const { x, y, x1, y1, x2, y2 } = input;
    switch (operation) {
        case "mobile_tap":
        case "mobile_double_tap":
            return { ok: true, intent: {kind:"tap",point:{x,y}},
                completion: {kind:operation === "mobile_double_tap" ? 'double-tapped' : 'tapped',point:{x,y}},
                doubleTap: operation === "mobile_double_tap" };
        case "mobile_long_press": {
            const { durationMs = 700 } = input;
            return { ok: true, intent: {kind:"swipe",swipe:{x1:x,y1:y,x2:x,y2:y,durationMs}},
                completion: {kind:'long-pressed',point:{x,y},durationMs}, doubleTap: false };
        }
        case "mobile_swipe":
        case "mobile_drag": {
            const { durationMs = operation === "mobile_drag" ? 700 : 300 } = input;
            return { ok: true, intent: {kind:"swipe",swipe:{x1,y1,x2,y2,durationMs}},
                completion: {kind:operation === "mobile_drag" ? 'dragged' : 'swiped',swipe:{x1,y1,x2,y2,durationMs}}, doubleTap: false };
        }
        case "mobile_type_text":
            return { ok: true, intent: {kind:"text",text:input.text},
                completion: {kind:'typed'}, doubleTap: false };
        case "mobile_key": {
            const key = input.keyCode ?? input.key;
            if (key === undefined || key === null || key === "") {
                return { ok: false, message: "mobile_key requires key or keyCode" };
            }
            return { ok: true, intent: {kind:"key",key},
                completion: {kind:'key',key}, doubleTap: false };
        }
        case "mobile_back":
        case "mobile_home":
        case "mobile_forward":
        case "mobile_recents":
        case "mobile_power":
        case "mobile_lock":
        case "mobile_unlock": {
            const navigation = /** @type {Navigation} */ (operation.slice("mobile_".length));
            return { ok: true, intent: {kind:'navigation',navigation},
                completion: {kind:'navigation',navigation},
                doubleTap: false };
        }
        default:
            return undefined;
    }
}

/** @param {Operation} operation @param {Arguments} input
 * @returns {{ok:false,message:string}|{ok:true,orientation:Orientation}} */
export function androidOrientationPlan(operation, input) {
    const orientation = operation === "mobile_rotate_left" ? "landscape"
        : operation === "mobile_rotate_right" ? "reverse-landscape" : input.orientation;
    switch (orientation) {
        case "portrait":
        case "landscape":
        case "reverse-portrait":
        case "reverse-landscape":
            return {ok:true,orientation};
        default: return { ok: false, message: `Unsupported Android orientation: ${orientation}` };
    }
}
