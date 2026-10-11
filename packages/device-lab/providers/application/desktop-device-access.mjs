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
            /** @type {import('../ports/desktop-device-access.mjs').WindowsAccessRequest} */
            const request = name === 'device_exec' ? {type:'exec',command:args.command} : name === 'device_screenshot' ? {type:'screenshot'} : {type:'accessibility_snapshot',...desktopAccessibilityLimits(args)};
            const result = await ports.request(target,request,args.helperTimeoutMs);
            if (result.error !== undefined) return {kind:'text',text:result.error};
            const response = result.response;
            if (!response.ok) return {kind:'text',text:response.error || (name === 'device_exec' ? 'Windows helper exec failed' : name === 'device_screenshot' ? 'Windows helper screenshot failed' : 'Windows helper accessibility snapshot failed')};
            if (name === 'device_exec') return {kind:'json',value:{stdout:response.stdout||'',stderr:response.stderr||'',status:response.status??0,provider:'windows-helper'}};
            if (name === 'device_accessibility_snapshot') return {kind:'json',value:{provider:response.accessibility?.provider||'windows-uiautomation',accessibility:response.accessibility||null,response}};
            const path = ports.screenshotPath(result.helper,response);
            if (!path) return {kind:'text',text:'Windows helper screenshot output is missing or unsafe'};
            const image = ports.readScreenshot(path);
            if (image.kind === 'missing') return {kind:'text',text:`Windows helper screenshot output missing: ${path}`};
            if (image.kind === 'invalid') return {kind:'text',text:`Windows helper screenshot output is invalid: ${image.reason}`};
            return image;
        }
        if (name === 'device_accessibility_snapshot') {
            const limits = desktopAccessibilityLimits(args);
            const helper = ports.helper(target,[String(limits.maxDepth),String(limits.maxNodes)],args.helperTimeoutMs);
            if (helper.error !== undefined) return {kind:'native',value:helper.error};
            if (helper.result.status !== 0) return {kind:'command-failure',receipt:helper.result};
            const payload = ports.parseHelper(helper.result.stdout);
            return {kind:'json',value:{provider:payload?.accessibility?.provider||payload?.provider||'macos-system-events',remoteScriptPath:helper.remoteScriptPath,accessibility:payload?.accessibility||null,response:payload,stdout:helper.result.stdout,stderr:helper.result.stderr,status:helper.result.status}};
        }
        const selected = ports.bridge(target,name === 'device_exec' ? 'device_exec' : 'device_screenshot');
        if (!selected.ok) return {kind:'native',value:selected.result};
        if (name === 'device_exec') {
            const result = ports.exec(target,selected.bridge,args.command,args.helperTimeoutMs);
            return {kind:'json',value:{stdout:result.stdout,stderr:result.stderr,status:result.status,provider:'ssh'}};
        }
        const stage = ports.stageScreenshot(target);
        try {
            const capture = ports.capture(target,selected.bridge,stage,args.helperTimeoutMs);
            if (capture.status !== 0) return {kind:'command-failure',receipt:capture};
            const copy = ports.copy(target,selected.bridge,stage,args.helperTimeoutMs);
            if (copy.status !== 0) return {kind:'command-failure',receipt:copy};
            return {kind:'native',value:ports.readScreenshot(stage)};
        } finally {
            ports.cleanupRemote(target,selected.bridge,stage,args.helperTimeoutMs);
            ports.disposeScreenshot(stage);
        }
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
        try {
            const result = ports.capture(stage);
            if (result.status !== 0) return {kind:'command-failure',receipt:result};
            return {kind:'native',value:ports.readScreenshot(stage)};
        } finally { ports.disposeScreenshot(stage); }
    }
    return {current,handle};
}
