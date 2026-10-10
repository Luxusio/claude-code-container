/** @typedef {{deviceId?:string,x?:number,y?:number,x1?:number,y1?:number,x2?:number,y2?:number,durationMs?:number,text?:string,key?:string|number|null,keyCode?:string|number|null,orientation?:string,localPath?:string,remotePath?:string,bundleId?:string,containerType?:string}} IosControlArgs */
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
/** @param {string} type @param {object[]} steps */
function pointerActions(type, steps) {
    return {
        actions: [{
                type: "pointer", id: "finger1", parameters: {
                    pointerType: "touch"
                }, actions: steps
            }], gesture: type
    };
}
/** @typedef {{path:string,body:object,payload:object} | {error:string} | {invalidOrientation:true}} IosControlRequest */
/** @param {string} name @param {IosControlArgs} args @returns {IosControlRequest|null} */
export function iosControlRequest(name, args) {
    const { x, y, x1, y1, x2, y2 } = args;
    const down = {
        type: "pointerDown", button: 0
    };
    const up = {
        type: "pointerUp", button: 0
    };
    const move = {
        type: "pointerMove", duration: 0, x, y
    };
    if (name === "mobile_tap") {
        return {
            path: "/actions", body: pointerActions("tap", [move, down, up]), payload: {
                tapped: {
                    x, y
                }
            }
        };
    }
    if (name === "mobile_double_tap") {
        return {
            path: "/actions", body: pointerActions("doubleTap", [move, down, up, {
                    type: "pause", duration: 80
                }, down, up]), payload: {
                doubleTapped: {
                    x, y
                }
            }
        };
    }
    if (name === "mobile_long_press") {
        const durationMs = args.durationMs === undefined ? 700 : args.durationMs;
        return {
            path: "/actions", body: pointerActions("longPress", [move, down, {
                    type: "pause", duration: durationMs
                }, up]), payload: {
                longPressed: {
                    x, y, durationMs
                }
            }
        };
    }
    if (name === "mobile_swipe" || name === "mobile_drag") {
        const durationMs = args.durationMs === undefined ? (name === "mobile_drag" ? 700 : 300) : args.durationMs;
        const drag = name === "mobile_drag";
        return {
            path: "/actions", body: pointerActions(drag ? "drag" : "swipe", [{
                    type: "pointerMove", duration: 0, x: x1, y: y1
                }, down, {
                    type: "pointerMove", duration: durationMs, x: x2, y: y2
                }, up]), payload: {
                [drag ? "dragged" : "swiped"]: {
                    x1, y1, x2, y2, durationMs
                }
            }
        };
    }
    if (name === "mobile_type_text") {
        const text = String(args.text);
        return {
            path: "/keys", body: {
                text, value: [...text]
            }, payload: {
                typed: true
            }
        };
    }
    if (name === "mobile_key") {
        const key = args.key ?? args.keyCode;
        if (key === undefined || key === null || key === "") {
            return {
                error: "mobile_key requires key or keyCode"
            };
        }
        return {
            path: "/keys", body: {
                text: String(key), value: [String(key)]
            }, payload: {
                key
            }
        };
    }
    if (name === "mobile_home") {
        return {
            path: "/execute/sync", body: {
                script: "mobile: pressButton", args: [{
                        name: "home"
                    }]
            }, payload: {
                home: true
            }
        };
    }
    if (name === "mobile_lock" || name === "mobile_unlock") {
        return {
            path: "/execute/sync", body: {
                script: name === "mobile_lock" ? "mobile: lock" : "mobile: unlock", args: []
            }, payload: name === "mobile_lock" ? {
                locked: true
            } : {
                unlocked: true
            }
        };
    }
    if (["mobile_set_orientation", "mobile_rotate_left", "mobile_rotate_right"].includes(name)) {
        const orientation = name === "mobile_rotate_left" ? "LANDSCAPE" : name === "mobile_rotate_right" ? "PORTRAIT" : String(args.orientation || "");
        const resolved = iosControlOrientation(orientation);
        if (!resolved) {
            return {
                invalidOrientation: true
            };
        }
        return {
            path: "/orientation", body: {
                orientation: resolved.orientation
            }, payload: resolved
        };
    }
    return null;
}
/** @param {{relativePath:string, absolute:boolean}} facts */
export function iosContainerRelativePathAllowed(facts) {
    const relative = facts.relativePath;
    return Boolean(relative && relative !== "." && !facts.absolute && relative !== ".." && !relative.startsWith("../") && !relative.startsWith("..\\"));
}
