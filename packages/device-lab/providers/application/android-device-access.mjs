/** Wait-only composition also serves the existing raw native wait exports.
 * @template Target @param {import('../ports/android-device-access.mjs').AndroidAccessWaitPorts<Target>} ports */
export function createAndroidAccessWait(ports) {
    /** @param {Target} target @param {string} remotePath @param {string|undefined} text @param {number|undefined} timeoutMs @param {number|undefined} intervalMs
     * @returns {Promise<import('../ports/android-device-access.mjs').AndroidTextWaitResult>} */
    async function text(target, remotePath, text, timeoutMs, intervalMs) {
        const wait = ports.budget(timeoutMs, intervalMs);
        /** @type {import('../ports/android-device-access.mjs').AndroidTextWaitResult} */
        let last = {kind:"deadline",subject:"ui"};
        while (wait.remaining() > 0) {
            const allowance = wait.requestTimeout();
            if (allowance <= 0) break;
            const dump = ports.dumpUi(target,remotePath,allowance);
            if (!dump.ok) last = {kind:"native-failure",diagnostic:dump.diagnostic};
            else {
                const readAllowance = wait.requestTimeout();
                if (readAllowance <= 0) break;
                let read = ports.readUi(target,remotePath,"primary",readAllowance);
                if (!read.ok && wait.remaining() > 0) {
                    const fallbackAllowance = wait.requestTimeout();
                    if (fallbackAllowance > 0) read = ports.readUi(target,remotePath,"fallback",fallbackAllowance);
                }
                if (!read.ok) last = {kind:"native-failure",diagnostic:read.diagnostic};
                else {
                    const source = read.value;
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
        let last = {kind:"deadline",subject:"app"};
        while (wait.remaining() > 0) {
            const allowance = wait.requestTimeout();
            if (allowance <= 0) break;
            const result = ports.observeApp(target,packageName,allowance);
            if (!result.ok) last = {kind:"native-failure",diagnostic:result.diagnostic};
            else {
                const observation = result.value;
                if (observation.running && observation.pid) return {running:true,pid:observation.pid,diagnostic:observation.diagnostic};
                last = {running:false,timeoutMs:wait.timeoutMs,diagnostic:observation.diagnostic};
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
            if (name === "mobile_session_status") return {kind:"session",device};
            if (name === "device_status") {
                if (ports.variant === "physical") {
                    const lease = ports.refreshLease(device);
                    if (!lease.ok) return {kind:"refused",message:lease.message};
                }
                const discovery = ports.discovery();
                const hostState = ports.variant === "physical" && discovery.adbAvailable ? ports.hostState(device,discovery) : null;
                return {kind:"status",device,discovery,hostState};
            }
            const discovery = ports.discovery();
            if (!discovery.adbAvailable) return {kind:"refused",message:"Android backend missing prerequisites: adb"};
            return effect(name,ports.targetForDevice(device,discovery),args);
        }
        const selected = ports.target(args.deviceId);
        if (selected.kind === "unknown") return undefined;
        if (selected.kind === "refused") return {kind:"refused",message:selected.message};
        return effect(name,selected.target,args);
    }
    /** @param {string} name @param {import('../ports/android-device-access.mjs').AndroidAccessTarget<Device>} target @param {import('../ports/android-device-access.mjs').AndroidAccessArguments} args
     * @returns {import('../ports/android-device-access.mjs').AndroidAccessOutcome} */
    function effect(name,target,args) {
        if (name === "device_screenshot") return ports.capture(target);
        if (name === "device_exec") {
            const result = ports.executeShell(target,args.command);
            return result.ok ? {kind:"executed",diagnostic:result.diagnostic} : {kind:"native-failure",diagnostic:result.diagnostic};
        }
        const remotePath = ports.uiPath(target.device);
        const dump = ports.dumpUi(target,remotePath);
        if (!dump.ok) return {kind:"native-failure",diagnostic:dump.diagnostic};
        let read = ports.readUi(target,remotePath,"primary");
        if (!read.ok) read = ports.readUi(target,remotePath,"fallback");
        return !read.ok ? {kind:"native-failure",diagnostic:read.diagnostic}
            : {kind:"ui",source:read.value,remotePath,dump:dump.diagnostic};
    }
    /** @param {'mobile_wait_for_text'|'mobile_wait_for_app'} name @param {import('../ports/android-device-access.mjs').AndroidAccessArguments} args
     * @returns {Promise<import('../ports/android-device-access.mjs').AndroidAccessOutcome|undefined>} */
    async function waitFor(name,args) {
        const selected = ports.target(args.deviceId);
        if (selected.kind === "unknown") return undefined;
        if (selected.kind === "refused") return {kind:"refused",message:selected.message};
        if (name === "mobile_wait_for_text") {
            if (ports.variant === "physical" && !args.text) return {kind:"refused",message:"Android wait-for-text requires text"};
            const result = await wait.text(selected.target,ports.uiPath(selected.target.device),args.text,args.timeoutMs,args.intervalMs);
            return "kind" in result && result.kind === "native-failure" ? result : {kind:"text-wait",result,text:args.text};
        }
        if (!args.packageName) return {kind:"refused",message:"Android wait-for-app requires packageName"};
        const result = await wait.app(selected.target,args.packageName,args.timeoutMs,args.intervalMs);
        return "kind" in result && result.kind === "native-failure" ? result : {kind:"app-wait",result,packageName:args.packageName};
    }
    return {request,waitFor};
}
