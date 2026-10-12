/** @param {import("../domain/ios-control-transfer.mjs").IosControlCommand} command */
function frameIosControl(command) {
    const { name, args } = command;
    const { x, y, x1, y1, x2, y2 } = args;
    const down = { type: "pointerDown", button: 0 };
    const up = { type: "pointerUp", button: 0 };
    const move = { type: "pointerMove", duration: 0, x, y };
    let steps;
    let gesture;
    if (name === "mobile_tap") { steps = [move, down, up]; gesture = "tap"; }
    else if (name === "mobile_double_tap") {
        steps = [move, down, up, { type: "pause", duration: 80 }, down, up]; gesture = "doubleTap";
    } else if (name === "mobile_long_press") {
        steps = [move, down, { type: "pause", duration: args.durationMs }, up]; gesture = "longPress";
    } else if (name === "mobile_swipe" || name === "mobile_drag") {
        steps = [{ type: "pointerMove", duration: 0, x: x1, y: y1 }, down,
            { type: "pointerMove", duration: args.durationMs, x: x2, y: y2 }, up];
        gesture = name === "mobile_drag" ? "drag" : "swipe";
    } else if (name === "mobile_type_text") {
        const text = String(args.text);
        return { path: "/keys", body: { text, value: [...text] } };
    } else if (name === "mobile_key") {
        const text = String(args.key ?? args.keyCode);
        return { path: "/keys", body: { text, value: [text] } };
    } else if (name === "mobile_home") {
        return { path: "/execute/sync", body: { script: "mobile: pressButton", args: [{ name: "home" }] } };
    } else if (name === "mobile_lock" || name === "mobile_unlock") {
        return { path: "/execute/sync", body: { script: name === "mobile_lock" ? "mobile: lock" : "mobile: unlock", args: [] } };
    } else {
        return { path: "/orientation", body: { orientation: args.orientation } };
    }
    return { path: "/actions", body: { actions: [{ type: "pointer", id: "finger1", parameters: { pointerType: "touch" }, actions: steps }], gesture } };
}
/** @param {(url:string, options:{method:string,body:string}) => Promise<unknown>} fetchJson
 * @param {import("../ports/ios-control-transfer.mjs").IosControlSession} session
 * @param {import("../domain/ios-control-transfer.mjs").IosControlCommand} command
 * @returns {Promise<import("../ports/ios-control-transfer.mjs").IosControlObservation>} */
export async function performIosControl(fetchJson, session, command) {
    const request = frameIosControl(command);
    try {
        await fetchJson(`${session.serverUrl}/session/${session.sessionId}${request.path}`, { method: "POST", body: JSON.stringify(request.body) });
        return { kind: "succeeded" };
    } catch (error) { return { kind: "failed", message: error instanceof Error ? error.message : String(error) }; }
}

/** Native simctl framing and diagnosis. Application policy receives only finite observations.
 * @param {{run: (executable:string|null,args:string[]) => import('../ports/lifecycle/ios-simulator-lifecycle.mjs').IosSimulatorCommandResult,
 * runWithTimeout: (executable:string|null,args:string[],timeoutMs:number) => import('../ports/lifecycle/ios-simulator-lifecycle.mjs').IosSimulatorCommandResult,
 * simctlJson: (executable:string|null,args:string[]) => {error?:import('../ports/lifecycle/ios-simulator-lifecycle.mjs').IosSimulatorCommandResult,value?:import('../ports/lifecycle/ios-simulator-lifecycle.mjs').IosSimulatorInventoryValue}}} native */
export function createIosSimulatorNative(native) {
    /** @param {import('../ports/lifecycle/ios-simulator-lifecycle.mjs').IosSimulatorCommandResult} receipt */
    function failed(receipt) { return {kind: /** @type {const} */ ("failed"), receipt, message: String(receipt.stderr || receipt.stdout)}; }
    return {
        /** @param {string|null} xcrun */
        inventory(xcrun) {
            const listed = native.simctlJson(xcrun,["list","devices","-j"]);
            if (listed.error) return { ...failed(listed.error), message: boundedSimulatorIdentityDetail(listed.error.stderr || listed.error.stdout || `exit ${listed.error.status}`) };
            const devices = Object.values(listed.value?.devices || {}).flatMap(items => Array.isArray(items) ? items : []);
            return {kind: /** @type {const} */ ("listed"), devices};
        },
        /** @param {string|null} xcrun @param {string} name @param {string} deviceType @param {string} runtime */
        createSimulator(xcrun,name,deviceType,runtime) {
            const receipt = native.run(xcrun,["simctl","create",name,deviceType,runtime]);
            if (receipt.status !== 0) return failed(receipt);
            return {kind: /** @type {const} */ ("created"), udid:receipt.stdout.trim()};
        },
        /** @param {string|null} xcrun @param {"boot"|"shutdown"|"delete"} operation @param {string} target */
        simulatorOperation(xcrun,operation,target) {
            const receipt = native.run(xcrun,["simctl",operation,target]);
            const already = operation === "boot" ? "Unable to boot device in current state: Booted" : operation === "shutdown" ? "Unable to shutdown device in current state: Shutdown" : "Invalid device";
            if (receipt.status !== 0 && !String(receipt.stderr || receipt.stdout).includes(already)) return failed(receipt);
            return {kind: /** @type {const} */ ("succeeded"), receipt};
        },
        /** @param {string|null} xcrun @param {string} target @param {number} timeoutMs */
        waitForBoot(xcrun,target,timeoutMs) {
            const receipt = native.runWithTimeout(xcrun,["simctl","bootstatus",target,"-b"],timeoutMs);
            return {ready:receipt.status === 0,skipped:false,status:receipt.status,stdout:receipt.stdout,stderr:receipt.stderr,...(receipt.error ? {error:receipt.error} : {})};
        },
    };
}

/** @param {unknown} value */
function boundedSimulatorIdentityDetail(value) {
    const text = String(value || "").trim();
    return text.length > 4096 ? `${text.slice(0, 4096)}...` : text;
}
