import { androidWaitCommandFailed, androidWaitFailure, androidScreenshotOutcome } from "../domain/android-device-access.mjs";

/** Wait-only composition also serves the existing raw native wait exports.
 * @template Target @param {import('../ports/android-device-access.mjs').AndroidAccessWaitPorts<Target>} ports */
export function createAndroidAccessWait(ports) {
    /** @param {Target} target @param {string} remotePath @param {string|undefined} text @param {number|undefined} timeoutMs @param {number|undefined} intervalMs
     * @returns {Promise<import('../ports/android-device-access.mjs').AndroidTextWaitResult>} */
    async function text(target, remotePath, text, timeoutMs, intervalMs) {
        const wait = ports.budget(timeoutMs, intervalMs);
        /** @type {import('../ports/android-device-access.mjs').AndroidTextWaitResult} */
        let last = androidWaitFailure({status:null,stderr:"Android wait deadline exhausted before observing UI"});
        while (wait.remaining() > 0) {
            const allowance = wait.requestTimeout();
            if (allowance <= 0) break;
            const dump = ports.executeTimed(target,["shell","uiautomator","dump",remotePath],allowance);
            if (androidWaitCommandFailed(dump)) last = androidWaitFailure(dump);
            else {
                const readAllowance = wait.requestTimeout();
                if (readAllowance <= 0) break;
                let read = ports.executeTimed(target,["exec-out","cat",remotePath],readAllowance);
                if (androidWaitCommandFailed(read) && wait.remaining() > 0) {
                    const fallbackAllowance = wait.requestTimeout();
                    if (fallbackAllowance > 0) read = ports.executeTimed(target,["shell","cat",remotePath],fallbackAllowance);
                }
                if (androidWaitCommandFailed(read)) last = androidWaitFailure(read);
                else {
                    const source = read.stdout || "";
                    last = {found:false,source,timeoutMs:wait.timeoutMs};
                    if (source.includes(String(text))) return {found:true,source,remotePath};
                }
            }
            await wait.pause();
        }
        return last;
    }
    /** @param {Target} target @param {string} packageName @param {number|undefined} timeoutMs @param {number|undefined} intervalMs
     * @returns {Promise<import('../ports/android-device-access.mjs').AndroidAppWaitResult>} */
    async function app(target, packageName, timeoutMs, intervalMs) {
        const wait = ports.budget(timeoutMs,intervalMs);
        /** @type {import('../ports/android-device-access.mjs').AndroidAppWaitResult} */
        let last = androidWaitFailure({status:null,stderr:"Android wait deadline exhausted before observing the app"});
        while (wait.remaining() > 0) {
            const allowance = wait.requestTimeout();
            if (allowance <= 0) break;
            const result = ports.executeTimed(target,["shell","pidof",packageName],allowance);
            const absent = result.status === 1 && !result.stdout && !result.stderr && !result.error && !result.signal;
            if (androidWaitCommandFailed(result) && !absent) last = androidWaitFailure(result);
            else {
                const stdout = result.stdout || "";
                const pid = stdout.trim();
                if (pid) return {running:true,pid,stdout,stderr:result.stderr,status:result.status};
                last = {running:false,timeoutMs:wait.timeoutMs,stdout,stderr:result.stderr,status:0,nativeStatus:result.status};
            }
            await wait.pause();
        }
        return last;
    }
    return {text,app};
}

/** @template {import('../ports/android-device-access.mjs').AndroidAccessDevice} Device
 * @template {import('../ports/android-device-access.mjs').AndroidAccessDiscovery} Discovery
 * @param {import('../ports/android-device-access.mjs').AndroidDeviceAccessPorts<Device,Discovery>} ports */
export function createAndroidDeviceAccess(ports) {
    const wait = createAndroidAccessWait(ports);
    /** @param {string} name @param {import('../ports/android-device-access.mjs').AndroidAccessArguments} args
     * @returns {import('../ports/android-device-access.mjs').AndroidAccessOutcome|undefined} */
    function request(name,args) {
        if (!["device_status","mobile_session_status","device_exec","device_screenshot","mobile_dump_ui"].includes(name)) return undefined;
        if (name === "device_status" || name === "mobile_session_status" || ports.variant === "emulator" && name !== "mobile_dump_ui") {
            const device = ports.device(args.deviceId);
            if (!device) return undefined;
            if (name === "mobile_session_status") {
                const appium = ports.appium(undefined);
                return {kind:"json",payload:ports.variant === "physical"
                    ? {deviceId:device.id,appium,session:device.appium||null,lazy:true,automationName:"UiAutomator2"}
                    : {deviceId:args.deviceId,device:ports.publicDevice(device),provider:"adb",appium,session:device.appium||null,lazy:true}};
            }
            if (name === "device_status") {
                if (ports.variant === "physical") {
                    const lease = ports.refreshLease(device);
                    if (!lease.ok) return {kind:"text",message:lease.message};
                }
                const discovery = ports.discovery();
                if (ports.variant === "physical") {
                    const state = discovery.adb ? ports.hostState(device,discovery.adb) : null;
                    return {kind:"json",payload:{device:ports.publicDevice(device),backend:ports.backend(discovery),hostState:state ? {stdout:(state.stdout||"").trim(),stderr:state.stderr,status:state.status}:null,
                        appium:{deviceId:device.id,appium:ports.appium(discovery),session:device.appium||null,lazy:true,automationName:"UiAutomator2"}}};
                }
                return {kind:"json",payload:{device:ports.publicDevice(device),backend:ports.backend(discovery),appium:ports.appium(discovery),automation:{deviceId:args.deviceId,provider:"adb",session:device.appium||null,lazy:true}}};
            }
            const discovery = ports.discovery();
            if (!discovery.adb) return {kind:"text",message:"Android backend missing prerequisites: adb"};
            return effect(name,{device,adb:discovery.adb},args);
        }
        const selected = ports.target(args.deviceId);
        if (selected.kind === "unknown") return undefined;
        if (selected.kind === "refused") return {kind:"text",message:selected.message};
        return effect(name,selected.target,args);
    }
    /** @param {string} name @param {import('../ports/android-device-access.mjs').AndroidAccessTarget<Device>} target @param {import('../ports/android-device-access.mjs').AndroidAccessArguments} args
     * @returns {import('../ports/android-device-access.mjs').AndroidAccessOutcome} */
    function effect(name,target,args) {
        if (name === "device_screenshot") return androidScreenshotOutcome(ports.capture(target));
        if (name === "device_exec") {
            const result = ports.execute(target,["shell",args.command]);
            return result.status === 0 ? {kind:"json",payload:{stdout:result.stdout,stderr:result.stderr,status:result.status}} : {kind:"command-failure",command:result};
        }
        const remotePath = `/sdcard/window-${target.device.id}.xml`;
        const dump = ports.execute(target,["shell","uiautomator","dump",remotePath]);
        if (dump.status !== 0) return {kind:"command-failure",command:dump};
        let read = ports.execute(target,["exec-out","cat",remotePath]);
        if (read.status !== 0) read = ports.execute(target,["shell","cat",remotePath]);
        return read.status !== 0 ? {kind:"command-failure",command:read}
            : {kind:"json",payload:{provider:"adb-uiautomator",source:read.stdout,remotePath,stdout:dump.stdout,stderr:dump.stderr}};
    }
    /** @param {'mobile_wait_for_text'|'mobile_wait_for_app'} name @param {import('../ports/android-device-access.mjs').AndroidAccessArguments} args
     * @returns {Promise<import('../ports/android-device-access.mjs').AndroidAccessOutcome|undefined>} */
    async function waitFor(name,args) {
        const selected = ports.target(args.deviceId);
        if (selected.kind === "unknown") return undefined;
        if (selected.kind === "refused") return {kind:"text",message:selected.message};
        if (name === "mobile_wait_for_text") {
            if (ports.variant === "physical" && !args.text) return {kind:"text",message:"Android wait-for-text requires text"};
            const result = await wait.text(selected.target,`/sdcard/window-${selected.target.device.id}.xml`,args.text,args.timeoutMs,args.intervalMs);
            return "error" in result ? {kind:"command-failure",command:result.error} : {kind:"json",payload:{...result,text:args.text,provider:"adb-uiautomator"}};
        }
        if (!args.packageName) return {kind:"text",message:"Android wait-for-app requires packageName"};
        const result = await wait.app(selected.target,args.packageName,args.timeoutMs,args.intervalMs);
        return "error" in result ? {kind:"command-failure",command:result.error} : {kind:"json",payload:{...result,packageName:args.packageName,provider:"adb"}};
    }
    return {request,waitFor};
}
