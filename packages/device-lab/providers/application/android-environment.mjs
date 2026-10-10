import { validAndroidNetwork, androidBatteryCommands, androidRadioCommands, androidAirplaneCommands, androidGeoArguments, environmentUnsupportedMessage } from "../domain/mobile-environment.mjs";

/** @template {import('../ports/mobile-environment.mjs').AndroidEnvironmentTarget} Target
 * @param {import('../ports/mobile-environment.mjs').AndroidEnvironmentPorts<Target>} ports */
export function createAndroidEnvironment(ports) {
    /** @param {Target} target @param {unknown} enabled
     * @returns {import('../ports/mobile-environment.mjs').EnvironmentOutcome} */
    function airplane(target, enabled) {
        const commands = androidAirplaneCommands(enabled);
        const modern = ports.execute(target, commands.modern);
        if (modern.status === 0) return { kind: "json", payload: { airplaneMode: enabled, provider: "adb", method: "connectivity-shell", stdout: modern.stdout, stderr: modern.stderr, status: modern.status } };
        const setting = ports.execute(target, commands.setting);
        if (setting.status !== 0) return { kind: "json", payload: { ok: false, error: "android-network-command-failed", detail: "airplaneMode.setting", status: setting.status, stderr: setting.stderr } };
        const broadcast = ports.execute(target, commands.broadcast);
        if (broadcast.status !== 0) return { kind: "json", payload: { ok: false, error: "android-network-command-failed", detail: "airplaneMode.broadcast", applied: ["airplaneMode.setting"], status: broadcast.status, stderr: broadcast.stderr } };
        return { kind: "json", payload: { airplaneMode: enabled, provider: "adb", method: "legacy-broadcast", stdout: broadcast.stdout, stderr: broadcast.stderr, status: broadcast.status } };
    }

    /** @param {string} name @param {import('../ports/mobile-environment.mjs').EnvironmentArguments} args
     * @returns {import('../ports/mobile-environment.mjs').EnvironmentOutcome|undefined} */
    function request(name, args) {
        if (!["mobile_set_location", "mobile_set_battery", "mobile_set_network", "mobile_toggle_airplane_mode", "mobile_set_clipboard", "mobile_get_clipboard"].includes(name)) return undefined;
        const clipboard = name === "mobile_set_clipboard" || name === "mobile_get_clipboard";
        if (ports.variant === "physical" && !clipboard) {
            return ports.device(args.deviceId) ? { kind: "text", message: environmentUnsupportedMessage("android-physical", name) } : undefined;
        }
        if (name === "mobile_set_network" && !validAndroidNetwork(args)) return { kind: "text", message: "Android network control requires boolean wifi, data or airplaneMode" };
        const selected = ports.target(args.deviceId);
        if (selected.kind === "unknown") return undefined;
        if (selected.kind === "refused") return { kind: "text", message: selected.message };
        const target = selected.target;
        if (name === "mobile_set_location" && ports.variant === "emulator") {
            const serial = ports.serial(target);
            if (!serial) return { kind: "text", message: "Android location requires an emulator serial or port" };
            const result = ports.executeEmulator(target, serial, androidGeoArguments(args));
            return result.status === 0 ? { kind: "json", payload: { location: { latitude: args.latitude, longitude: args.longitude, altitude: args.altitude ?? null }, provider: "adb-emulator", stdout: result.stdout, stderr: result.stderr, status: result.status } } : { kind: "command-failure", command: result };
        }
        if (name === "mobile_set_battery") {
            const commands = androidBatteryCommands(args);
            if (commands.length === 0) return { kind: "text", message: "Android battery control requires level, status, or charging" };
            /** @type {import('../ports/mobile-environment.mjs').EnvironmentStreams[]} */
            const results = [];
            for (const command of commands) {
                const result = ports.execute(target, command);
                if (result.status !== 0) return { kind: "command-failure", command: result };
                results.push({ stdout: result.stdout, stderr: result.stderr, status: result.status });
            }
            return { kind: "json", payload: { battery: { level: args.level ?? null, status: args.status ?? null, charging: args.charging ?? null }, results, provider: "adb" } };
        }
        if (name === "mobile_toggle_airplane_mode") return airplane(target, args.enabled);
        if (name === "mobile_set_network") {
            if (args.airplaneMode !== undefined) {
                const result = airplane(target, args.airplaneMode);
                if (result.kind === "json" && "ok" in result.payload && result.payload.ok === false) return result;
            }
            const applied = args.airplaneMode === undefined ? [] : ["airplaneMode"];
            for (const command of androidRadioCommands(args)) {
                const result = ports.execute(target, command.args);
                if (result.status !== 0) return { kind: "json", payload: { ok: false, error: "android-network-command-failed", detail: command.setting, applied, status: result.status, stderr: result.stderr, stdout: result.stdout } };
                applied.push(command.setting);
            }
            return { kind: "json", payload: { network: { wifi: args.wifi ?? null, data: args.data ?? null, airplaneMode: args.airplaneMode ?? null }, provider: "adb" } };
        }
        const result = ports.execute(target, name === "mobile_set_clipboard" ? ["shell", "cmd", "clipboard", "set", String(args.text)] : ["shell", "cmd", "clipboard", "get"]);
        if (result.status !== 0) return { kind: "command-failure", command: result };
        return name === "mobile_set_clipboard"
            ? { kind: "json", payload: { clipboard: { set: true }, provider: "adb", stdout: result.stdout, stderr: result.stderr, status: result.status } }
            : { kind: "json", payload: { text: result.stdout, stderr: result.stderr, status: result.status, provider: "adb" } };
    }
    return { request };
}
