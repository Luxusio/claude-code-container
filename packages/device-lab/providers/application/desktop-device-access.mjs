import { desktopAccessibilityLimits, x11AccessTarget } from '../domain/desktop-device-access.mjs';

/** @template {import('../ports/desktop-device-access.mjs').DesktopAccessTarget} Target
 * @template Helper
 * @template {import('../ports/desktop-device-access.mjs').DesktopAccessDiscovery} Discovery
 * @template {import('../ports/desktop-device-access.mjs').DesktopAccessBridge} Bridge
 * @template {import('../ports/desktop-device-access.mjs').DesktopScreenshotStage} Stage
 * @param {import('../ports/desktop-device-access.mjs').DesktopDeviceAccessPorts<Target,Helper,Discovery,Bridge,Stage>} ports */
export function createDesktopDeviceAccess(ports) {
    /** @param {string} name @param {import('../ports/desktop-device-access.mjs').DesktopAccessArguments} args
     * @returns {Promise<import('../ports/desktop-device-access.mjs').DesktopAccessOutcome|undefined>} */
    async function handle(name,args) {
        if (!['device_status','device_exec','device_screenshot','device_accessibility_snapshot'].includes(name)) return undefined;
        const target = ports.target(args.deviceId);
        if (!target) return undefined;
        if (name === 'device_status') {
            if (ports.variant === 'windows') return {kind:'json',value:{device:ports.publicDevice(target),backend:ports.backend()}};
            const discovery = ports.discovery();
            return {kind:'json',value:{device:ports.publicDevice(target,discovery),backend:ports.backend(discovery)}};
        }
        if (ports.variant === 'windows') {
            const result = name === 'device_exec'
                ? await ports.exec(target,args.command,args.helperTimeoutMs)
                : name === 'device_screenshot'
                    ? await ports.screenshot(target,args.helperTimeoutMs)
                    : await ports.accessibility(target,desktopAccessibilityLimits(args),args.helperTimeoutMs);
            if (!result.ok) return result.outcome;
            if (name !== 'device_screenshot') return {kind:'json',value:/** @type {{ok:true,value:object}} */ (result).value};
            const path = /** @type {{ok:true,path:string}} */ (result).path;
            const image = ports.readScreenshot(path);
            if (image.kind === 'missing') return {kind:'text',text:`Windows helper screenshot output missing: ${path}`};
            if (image.kind === 'invalid') return {kind:'text',text:`Windows helper screenshot output is invalid: ${image.reason}`};
            return image;
        }
        if (name === 'device_accessibility_snapshot') {
            const result = ports.accessibility(target,desktopAccessibilityLimits(args),args.helperTimeoutMs);
            return result.ok ? {kind:'json',value:result.value} : result.outcome;
        }
        const selected = ports.bridge(target,name === 'device_exec' ? 'device_exec' : 'device_screenshot');
        if (!selected.ok) return {kind:'native',value:selected.result};
        if (name === 'device_exec') {
            return {kind:'json',value:ports.exec(target,selected.bridge,args.command,args.helperTimeoutMs)};
        }
        const stage = ports.stageScreenshot(target);
        /** @type {import('../ports/desktop-device-access.mjs').DesktopAccessOutcome|undefined} */
        let outcome;
        /** @type {unknown[]} */
        const failures = [];
        try {
            const capture = ports.capture(target,selected.bridge,stage,args.helperTimeoutMs);
            if (!capture.ok) outcome = {kind:'command-failure',receipt:capture.receipt};
            else {
                const copy = ports.copy(target,selected.bridge,stage,args.helperTimeoutMs);
                if (!copy.ok) outcome = {kind:'command-failure',receipt:copy.receipt};
                else {
                    const image = ports.readScreenshot(stage);
                    outcome = image.kind === 'image' ? image : {kind:'text',text:image.message};
                }
            }
        } catch (error) { failures.push(error); }
        const primaryFailed = failures.length > 0;
        try {
            const cleanup = ports.cleanupRemote(target,selected.bridge,stage,args.helperTimeoutMs);
            if (!cleanup.ok) failures.push(Object.assign(new Error('Remote screenshot cleanup failed'),{receipt:cleanup.receipt}));
        } catch (error) { failures.push(error); }
        try { ports.disposeScreenshot(stage); } catch (error) { failures.push(error); }
        if (failures.length) {
            if (primaryFailed && failures.length === 1) throw failures[0];
            if (!primaryFailed && outcome && outcome.kind !== 'image') failures.unshift(outcome);
            throw Object.assign(new AggregateError(failures,'Screenshot operation or cleanup failed',{cause:failures[0]}),{outcome});
        }
        return outcome;
    }
    return {handle};
}

/** @template {import('../ports/desktop-device-access.mjs').DesktopAccessTarget} Target
 * @template {import('../ports/desktop-device-access.mjs').DesktopScreenshotStage} Stage
 * @param {import('../ports/desktop-device-access.mjs').X11DeviceAccessPorts<Target,Stage>} ports */
export function createDisplayDeviceAccess(ports) {
    function current() { return ports.publicTarget(x11AccessTarget(ports.owner(), ports.display(), ports.available())); }
    /** @param {string} name
     * @returns {Promise<import('../ports/desktop-device-access.mjs').DesktopAccessOutcome|undefined>} */
    async function handle(name) {
        if (name === 'display_current') return {kind:'json',value:current()};
        if (name !== 'display_screenshot') return undefined;
        const stage = ports.stageScreenshot();
        /** @type {import('../ports/desktop-device-access.mjs').DesktopAccessOutcome|undefined} */
        let outcome;
        /** @type {unknown[]} */
        const failures = [];
        try {
            const result = ports.capture(stage);
            if (!result.ok) outcome = {kind:'command-failure',receipt:result.receipt};
            else {
                const image = ports.readScreenshot(stage);
                outcome = image.kind === 'image' ? image : {kind:'text',text:image.message};
            }
        } catch (error) { failures.push(error); }
        const primaryFailed = failures.length > 0;
        try { ports.disposeScreenshot(stage); } catch (error) { failures.push(error); }
        if (failures.length) {
            if (primaryFailed && failures.length === 1) throw failures[0];
            if (!primaryFailed && outcome && outcome.kind !== 'image') failures.unshift(outcome);
            throw Object.assign(new AggregateError(failures,'Screenshot operation or cleanup failed',{cause:failures[0]}),{outcome});
        }
        return outcome;
    }
    return {current,handle};
}
