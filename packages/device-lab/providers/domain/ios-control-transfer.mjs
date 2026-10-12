/** @typedef {{deviceId?:string,x?:number,y?:number,x1?:number,y1?:number,x2?:number,y2?:number,durationMs?:number,text?:string,key?:string|number|null,keyCode?:string|number|null,orientation?:string,localPath?:string,remotePath?:string,bundleId?:string,containerType?:string}} IosControlArgs */
/** @typedef {"mobile_tap" | "mobile_double_tap" | "mobile_long_press" | "mobile_swipe" | "mobile_drag" | "mobile_type_text" | "mobile_key" | "mobile_home" | "mobile_lock" | "mobile_unlock" | "mobile_set_orientation" | "mobile_rotate_left" | "mobile_rotate_right"} IosControlName */
/** @typedef {{name:IosControlName,args:IosControlArgs,payload:object}} IosControlCommand */
/** @typedef {IosControlCommand | {error:string} | {invalidOrientation:true}} IosControlRequest */
/** @param {string} name @param {IosControlArgs} args @returns {IosControlRequest|null} */
export function iosControlRequest(name, args) {
    const {x,y,x1,y1,x2,y2} = args;
    let payload;
    if (name === "mobile_tap") payload = { tapped: {x,y} };
    else if (name === "mobile_double_tap") payload = { doubleTapped: {x,y} };
    else if (name === "mobile_long_press") payload = { longPressed: {x,y,durationMs: args.durationMs === undefined ? 700 : args.durationMs} };
    else if (name === "mobile_swipe" || name === "mobile_drag") payload = { [name === "mobile_drag" ? "dragged" : "swiped"]: {x1,y1,x2,y2,durationMs: args.durationMs === undefined ? (name === "mobile_drag" ? 700 : 300) : args.durationMs} };
    else if (name === "mobile_type_text") payload = {typed:true};
    else if (name === "mobile_key") {
        const key = args.key ?? args.keyCode;
        if (key === undefined || key === null || key === "") return {error:"mobile_key requires key or keyCode"};
        payload = {key};
    }
    else if (name === "mobile_home") payload = {home:true};
    else if (name === "mobile_lock") payload = {locked:true};
    else if (name === "mobile_unlock") payload = {unlocked:true};
    else if (["mobile_set_orientation", "mobile_rotate_left", "mobile_rotate_right"].includes(name)) {
        const orientation = name === "mobile_rotate_left" ? "LANDSCAPE" : name === "mobile_rotate_right" ? "PORTRAIT" : String(args.orientation || "");
        const resolved = iosControlOrientation(orientation);
        if (!resolved) return {invalidOrientation:true};
        payload = resolved;
        args = {...args, orientation:resolved.orientation};
    } else return null;
    if (name === "mobile_long_press") args = {...args, durationMs: args.durationMs === undefined ? 700 : args.durationMs};
    if (name === "mobile_swipe" || name === "mobile_drag") args = {...args, durationMs: args.durationMs === undefined ? (name === "mobile_drag" ? 700 : 300) : args.durationMs};
    return {name: /** @type {IosControlName} */ (name),args,payload};
}
/** @param {string} orientation */
export function iosControlOrientation(orientation) {
    const requestedOrientation = String(orientation || "");
    const normalized = requestedOrientation.toLowerCase();
    if (normalized === "portrait" || normalized === "reverse-portrait") {
        return {
            orientation: "PORTRAIT", requestedOrientation
        };
    }
    if (normalized === "landscape" || normalized === "reverse-landscape") {
        return {
            orientation: "LANDSCAPE", requestedOrientation
        };
    }
    return null;
}
/** @param {{relativePath:string, absolute:boolean}} facts */
export function iosContainerRelativePathAllowed(facts) {
    const relative = facts.relativePath;
    return Boolean(relative && relative !== "." && !facts.absolute && relative !== ".." && !relative.startsWith("../") && !relative.startsWith("..\\"));
}
