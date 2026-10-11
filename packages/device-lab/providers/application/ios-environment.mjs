import { environmentUnsupportedMessage } from "../domain/mobile-environment.mjs";

/** @template Target
 * @template {import('../ports/mobile-environment.mjs').EnvironmentDevice} Device
 * @param {import('../ports/mobile-environment.mjs').IosEnvironmentPorts<Target, Device>} ports */
export function createIosEnvironment(ports) {
    /** @param {string} name @param {import('../ports/mobile-environment.mjs').EnvironmentArguments} args
     * @returns {import('../ports/mobile-environment.mjs').EnvironmentOutcome|undefined} */
    function request(name, args) {
        if (!["mobile_set_location", "mobile_set_battery", "mobile_set_network", "mobile_toggle_airplane_mode", "mobile_set_clipboard", "mobile_get_clipboard"].includes(name)) return undefined;
        if (ports.variant === "physical") {
            if (!ports.device(args.deviceId)) return undefined;
            return { kind: "refused", message: environmentUnsupportedMessage("ios-physical", name) };
        }
        const device = ports.device(args.deviceId);
        if (!device) return undefined;
        if (name === "mobile_set_battery" || name === "mobile_set_network" || name === "mobile_toggle_airplane_mode") {
            return { kind: "refused", message: environmentUnsupportedMessage("ios-simulator", name) };
        }
        const selected = ports.target(device);
        if (selected.kind === "missing-prerequisites") return { kind: "missing-prerequisites", missing: selected.missing };
        if (selected.kind === "refused") return { kind: "refused", message: selected.message };
        const target = selected.target;
        if (name === "mobile_set_location") {
            const location = { latitude: args.latitude, longitude: args.longitude };
            const result = ports.setLocation(target, location);
            return result.kind === "succeeded" ? { kind: "location-set", location, command: result.command } : { kind: "command-failure", command: result.command };
        }
        const result = name === "mobile_set_clipboard"
            ? ports.writeClipboard(target, String(args.text))
            : ports.readClipboard(target);
        if (result.kind === "failed") return { kind: "command-failure", command: result.command };
        return { kind: name === "mobile_set_clipboard" ? "clipboard-set" : "clipboard-read", command: result.command };
    }
    return { request };
}
