import { validAndroidNetwork, androidBatterySettings, androidRadioSettings, environmentUnsupportedMessage } from "../domain/mobile-environment.mjs";

/** @template Target
 * @param {import('../ports/mobile-environment.mjs').AndroidEnvironmentPorts<Target>} ports */
export function createAndroidEnvironment(ports) {
    /** @param {import('../ports/mobile-environment.mjs').AndroidEmulatorEnvironmentPorts<Target>} emulator
     * @param {Target} target @param {unknown} enabled
     * @returns {Extract<import('../ports/mobile-environment.mjs').EnvironmentOutcome,{kind:'airplane-set'|'network-failure'}>} */
    function airplane(emulator, target, enabled) {
        const modern = emulator.tryAirplaneMode(target, enabled);
        if (modern.kind === "succeeded") return { kind: "airplane-set", enabled, route: "modern", command: modern.command };
        const setting = emulator.setAirplaneSetting(target, enabled);
        if (setting.kind === "failed") return { kind: "network-failure", stage: "airplane-setting", command: setting.command };
        const broadcast = emulator.broadcastAirplaneMode(target, enabled);
        if (broadcast.kind === "failed") return { kind: "network-failure", stage: "airplane-broadcast", applied: ["airplane-setting"], command: broadcast.command };
        return { kind: "airplane-set", enabled, route: "legacy", command: broadcast.command };
    }

    /** @param {string} name @param {import('../ports/mobile-environment.mjs').EnvironmentArguments} args
     * @returns {import('../ports/mobile-environment.mjs').EnvironmentOutcome|undefined} */
    function request(name, args) {
        if (!["mobile_set_location", "mobile_set_battery", "mobile_set_network", "mobile_toggle_airplane_mode", "mobile_set_clipboard", "mobile_get_clipboard"].includes(name)) return undefined;
        const clipboard = name === "mobile_set_clipboard" || name === "mobile_get_clipboard";
        if (ports.variant === "physical" && !clipboard) {
            return ports.device(args.deviceId) ? { kind: "refused", message: environmentUnsupportedMessage("android-physical", name) } : undefined;
        }
        if (name === "mobile_set_network" && !validAndroidNetwork(args)) return { kind: "refused", message: "Android network control requires boolean wifi, data or airplaneMode" };
        const selected = ports.target(args.deviceId);
        if (selected.kind === "unknown") return undefined;
        if (selected.kind === "refused") return { kind: "refused", message: selected.message };
        const target = selected.target;
        if (ports.variant === "emulator") {
            if (name === "mobile_set_location") {
                const location = { latitude: args.latitude, longitude: args.longitude, altitude: args.altitude };
                const result = ports.setLocation(target, location);
                if (result.kind === "unavailable") return { kind: "refused", message: "Android location requires an emulator serial or port" };
                return result.kind === "succeeded" ? { kind: "location-set", location, command: result.command } : { kind: "command-failure", command: result.command };
            }
            if (name === "mobile_set_battery") {
                const settings = androidBatterySettings(args);
                if (settings.length === 0) return { kind: "refused", message: "Android battery control requires level, status, or charging" };
                /** @type {import('../ports/mobile-environment.mjs').EnvironmentCommandReceipt[]} */
                const commands = [];
                for (const setting of settings) {
                    const result = ports.setBattery(target, setting);
                    if (result.kind === "failed") return { kind: "command-failure", command: result.command };
                    commands.push(result.command);
                }
                return { kind: "battery-set", battery: { level: args.level, status: args.status, charging: args.charging }, commands };
            }
            if (name === "mobile_toggle_airplane_mode") return airplane(ports, target, args.enabled);
            if (name === "mobile_set_network") {
                if (args.airplaneMode !== undefined) {
                    const result = airplane(ports, target, args.airplaneMode);
                    if (result.kind === "network-failure") return result;
                }
                /** @type {import('../ports/mobile-environment.mjs').EnvironmentApplied[]} */
                const applied = args.airplaneMode === undefined ? [] : ["airplane"];
                for (const setting of androidRadioSettings(args)) {
                    const result = ports.setRadio(target, setting.setting, setting.enabled);
                    if (result.kind === "failed") return { kind: "network-failure", stage: setting.setting, applied, command: result.command };
                    applied.push(setting.setting);
                }
                return { kind: "network-set", network: { wifi: args.wifi, data: args.data, airplaneMode: args.airplaneMode } };
            }
        }
        const result = name === "mobile_set_clipboard"
            ? ports.writeClipboard(target, String(args.text))
            : ports.readClipboard(target);
        if (result.kind === "failed") return { kind: "command-failure", command: result.command };
        return { kind: name === "mobile_set_clipboard" ? "clipboard-set" : "clipboard-read", command: result.command };
    }
    return { request };
}
