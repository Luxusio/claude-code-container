import { environmentUnsupportedMessage, iosEnvironmentCommand } from "../domain/mobile-environment.mjs";

/** @template {import('../ports/mobile-environment.mjs').EnvironmentDevice} Device
 * @param {import('../ports/mobile-environment.mjs').IosEnvironmentPorts<Device>} ports */
export function createIosEnvironment(ports) {
    /** @param {string} name @param {import('../ports/mobile-environment.mjs').EnvironmentArguments} args
     * @returns {import('../ports/mobile-environment.mjs').EnvironmentOutcome|undefined} */
    function request(name, args) {
        if (!["mobile_set_location", "mobile_set_battery", "mobile_set_network", "mobile_toggle_airplane_mode", "mobile_set_clipboard", "mobile_get_clipboard"].includes(name)) return undefined;
        if (ports.variant === "physical") {
            if (!ports.device(args.deviceId)) return undefined;
            return { kind: "text", message: environmentUnsupportedMessage("ios-physical", name) };
        }
        const device = ports.device(args.deviceId);
        if (!device) return undefined;
        if (name === "mobile_set_battery" || name === "mobile_set_network" || name === "mobile_toggle_airplane_mode") {
            return { kind: "text", message: environmentUnsupportedMessage("ios-simulator", name) };
        }
        const discovery = ports.discovery();
        if (!discovery.available) return { kind: "missing-prerequisites", discovery };
        const target = ports.ownedTarget(discovery.xcrun, device);
        if (!target.ok) return { kind: "text", message: target.message };
        const plan = iosEnvironmentCommand(name, target.target, args);
        if (!plan) return undefined;
        const command = plan.input === undefined
            ? ports.execute(discovery.xcrun, plan.args)
            : ports.executeWithInput(discovery.xcrun, plan.args, plan.input);
        if (command.status !== 0) return { kind: "command-failure", command };
        if (name === "mobile_set_location") return { kind: "json", payload: {
            location: { latitude: args.latitude, longitude: args.longitude }, stdout: command.stdout, stderr: command.stderr, provider: "simctl",
        } };
        if (name === "mobile_set_clipboard") return { kind: "json", payload: {
            clipboard: { set: true }, stdout: command.stdout, stderr: command.stderr, provider: "simctl",
        } };
        return { kind: "json", payload: { text: command.stdout, stderr: command.stderr, status: command.status, provider: "simctl" } };
    }
    return { request };
}
