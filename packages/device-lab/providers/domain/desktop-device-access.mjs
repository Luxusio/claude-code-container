/** @typedef {{deviceId?:string,command?:string,helperTimeoutMs?:number,maxDepth?:number|string,maxNodes?:number|string}} DesktopAccessArguments */
/** @typedef {{id:string,kind:'display',backend:'x11',creatable:false,lifecycle:'current',ownerId:string,display:string,capabilities:string[],available:boolean}} X11AccessTarget */
/** @param {DesktopAccessArguments} args */
export function desktopAccessibilityLimits(args) {
    return {
        maxDepth: Math.max(0, Math.min(Number.isFinite(Number(args.maxDepth)) ? Number(args.maxDepth) : 3, 8)),
        maxNodes: Math.max(1, Math.min(Number.isFinite(Number(args.maxNodes)) ? Number(args.maxNodes) : 200, 1000)),
    };
}

/** @param {string} ownerId @param {string} display @param {boolean} available
 * @param {boolean} [focusAvailable]
 * @returns {X11AccessTarget} */
export function x11AccessTarget(ownerId, display, available, focusAvailable = false) {
    return {
        id: "x11-current-display", kind: "display", backend: "x11", creatable: false,
        lifecycle: "current", ownerId, display, available,
        capabilities: [
            "device_status", "device_screenshot", "device_click", "device_double_click",
            "device_key", "device_type", "device_scroll", "device_cursor_position",
            "device_window_list", "device_drag", ...(focusAvailable ? ["device_focus_window"] : []), "display_screenshot",
            "display_click", "display_double_click", "display_key", "display_type",
            "display_scroll", "display_cursor_position",
        ],
    };
}
