import { iosWirelessRefusal, iosWirelessStatus } from "../domain/ios-wireless.mjs";

/** @param {import("../ports/ios-wireless.mjs").IosWirelessPorts} ports */
export function createIosWirelessApplication(ports) {
    /** @param {import("../ports/ios-wireless.mjs").IosWirelessArguments} [args]
     * @returns {import("../ports/ios-wireless.mjs").IosWirelessOutcome|undefined} */
    function request(args = {}) {
        const { backend = "ios-device", action = "status", udid } = args;
        if (backend !== "ios-device") return undefined;
        if (action !== "status") {
            return { kind: "text", message: JSON.stringify(iosWirelessRefusal(action, { udid: udid || null }), null, 2) };
        }
        const discovery = ports.discover();
        if (!discovery.xcrun) {
            return { kind: "text", message: JSON.stringify(iosWirelessRefusal(action, { error: "ios-wireless-missing-xcrun", missing: ["xcrun"] }), null, 2) };
        }
        const inventory = ports.listDevices(discovery);
        if (!inventory.available) {
            return { kind: "text", message: JSON.stringify({
                ok: false, backend, action, error: "ios-wireless-inventory-failed",
                detail: inventory.error || inventory.missing.join(", "),
            }) };
        }
        return { kind: "json", payload: iosWirelessStatus(inventory, udid) };
    }
    return { request };
}
