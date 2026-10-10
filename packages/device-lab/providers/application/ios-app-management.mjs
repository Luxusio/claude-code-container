/** @template {import('../ports/mobile-app-management.mjs').IosSimulatorAppDevice} Device
 * @template {import('../ports/mobile-app-management.mjs').IosVerifiedAppSession} Session
 * @param {import('../ports/mobile-app-management.mjs').IosAppManagementPorts<Device, Session>} ports
 */
export function createIosAppManagement(ports) {
    /** @param {string} name @param {import('../ports/mobile-app-management.mjs').MobileAppArguments} args
     * @returns {Promise<import('../ports/mobile-app-management.mjs').IosAppOutcome<Device>|undefined>} */
    async function request(name, args) {
        const install = name === "device_install_app" || name === "mobile_install_app";
        const launch = name === "device_launch_app" || name === "mobile_launch_app";
        const stop = name === "mobile_stop_app";
        const uninstall = name === "mobile_uninstall_app";
        const permission = name === "mobile_grant_permission" || name === "mobile_revoke_permission";
        const openUrl = name === "mobile_open_url";
        const reset = name === "device_reset" || name === "mobile_clear_app_data";
        if (!install && !launch && !stop && !uninstall && !permission && !openUrl && !(reset && ports.variant === "simulator")) return undefined;
        if (ports.variant === "physical") {
            const device = ports.device(args.deviceId);
            if (!device) return undefined;
            if (uninstall || permission || openUrl) return { kind: "text", message: `iOS real devices do not support ${name} through CCC because the action is unavailable or unsafe for physical devices.` };
            if (install && !args.path) return { kind: "text", message: `iOS real-device ${name} requires path` };
            if ((launch || stop) && !args.bundleId) return { kind: "text", message: `iOS real-device ${name} requires bundleId` };
            if (stop && args.bundleId) {
                const resolved = await ports.session(args.deviceId);
                if (resolved.kind === "unknown") return undefined;
                if (resolved.kind === "refused") return { kind: "text", message: resolved.message };
                try {
                    await ports.request(resolved.session, "/execute/sync", { script: "mobile: terminateApp", args: [{ bundleId: args.bundleId }] });
                } catch (error) {
                    const message = error !== null && (typeof error === "object" || typeof error === "function") && "message" in error ? error.message : undefined;
                    return { kind: "text", message: `iOS real-device Appium request failed: ${message}` };
                }
                return { kind: "json", payload: { stopped: args.bundleId, provider: "appium-xcuitest", physical: true } };
            }
            const xcrun = ports.xcrun();
            if (!xcrun) return { kind: "text", message: "iOS real-device backend missing prerequisites: xcrun" };
            const command = ports.execute(xcrun, install
                ? ["devicectl", "device", "install", "app", "--device", device.udid, args.path]
                : ["devicectl", "device", "process", "launch", "--device", device.udid, args.bundleId], install ? 300000 : undefined);
            if (command.status !== 0) return { kind: "command-failure", command };
            return { kind: "json", payload: install
                ? { installed: args.path, udid: device.udid, provider: "xcrun-devicectl", stdout: command.stdout, stderr: command.stderr }
                : { launched: args.bundleId, udid: device.udid, provider: "xcrun-devicectl", stdout: command.stdout, stderr: command.stderr } };
        }

        const device = ports.device(args.deviceId);
        if (!device) return undefined;
        if ((stop || uninstall) && !args.bundleId) return { kind: "text", message: `iOS Simulator ${name} requires bundleId` };
        if (name === "mobile_clear_app_data" && !args.bundleId) return { kind: "text", message: "iOS Simulator mobile_clear_app_data requires bundleId" };
        if (permission && (!args.bundleId || !args.service)) return { kind: "text", message: `iOS Simulator ${name} requires bundleId and service` };
        const discovery = ports.discovery();
        if (!discovery.available) return { kind: "text", message: `iOS Simulator backend missing prerequisites: ${discovery.missing.join(", ")}` };
        if (reset && !args.bundleId) return { kind: "text", message: "iOS Simulator reset requires bundleId or eraseSimulator=true" };
        const owned = ports.ownedTarget(discovery.xcrun, device);
        if (!owned.ok) return { kind: "text", message: owned.message };
        if (reset && args.bundleId) {
            const type = args.containerType || "data";
            const container = ports.resolveAppContainer(discovery.xcrun, owned.target, args.bundleId, type);
            if (!container.ok) return { kind: "command-failure", command: container.command };
            const contained = ports.containAppContainer(container.containerRoot);
            if (!contained.ok) return { kind: "text", message: contained.message };
            ports.clearAppContainer(container.containerRoot);
            const updated = ports.publishAppReset(args.deviceId, { bundleId: args.bundleId, containerType: type, containerRoot: container.containerRoot, resetAt: ports.clock() }, ports.clock());
            return { kind: "json", payload: { reset: { bundleId: args.bundleId, containerType: type }, containerRoot: container.containerRoot, device: updated, provider: "simctl-app-container" } };
        }
        const action = name === "mobile_grant_permission" ? "grant" : "revoke";
        const command = ports.execute(discovery.xcrun, install ? ["simctl", "install", owned.target, args.path]
            : launch ? ["simctl", "launch", owned.target, args.bundleId]
            : stop ? ["simctl", "terminate", owned.target, args.bundleId]
            : uninstall ? ["simctl", "uninstall", owned.target, args.bundleId]
            : permission ? ["simctl", "privacy", owned.target, action, args.service, args.bundleId]
            : ["simctl", "openurl", owned.target, args.url], install ? 300000 : undefined);
        if (command.status !== 0) return { kind: "command-failure", command };
        const output = { stdout: command.stdout, stderr: command.stderr };
        if (install) return { kind: "json", payload: { installed: args.path, ...output } };
        if (launch) return { kind: "json", payload: { launched: args.bundleId, ...output } };
        if (stop && args.bundleId) return { kind: "json", payload: { stopped: args.bundleId, provider: "simctl", ...output } };
        if (uninstall && args.bundleId) return { kind: "json", payload: { uninstalled: args.bundleId, provider: "simctl", ...output } };
        if (permission && args.bundleId && args.service) return { kind: "json", payload: { permission: { bundleId: args.bundleId, service: args.service, action }, provider: "simctl", ...output } };
        return { kind: "json", payload: { openedUrl: args.url, provider: "simctl", ...output } };
    }
    return { request };
}
