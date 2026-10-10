/** @typedef {{name:string,udid:string,version:string|null,connection:string,raw:string}} IosWirelessDevice */
/** @typedef {{available:boolean,missing:string[],devices:IosWirelessDevice[],error?:string,then?:never}} IosWirelessInventory */
/** @typedef {{backend?:unknown,action?:unknown,udid?:unknown}} IosWirelessArguments */

/** @param {unknown} action @param {{udid?:unknown,error?:string,missing?:string[]}} [details] */
export function iosWirelessRefusal(action, details = {}) {
    return {
        ok: false,
        backend: "ios-device",
        action,
        error: "ios-wireless-pairing-requires-xcode-trust",
        message: "CCC can attach iOS Wi-Fi devices only after Apple trust and Xcode network pairing are already satisfied on the macOS host.",
        attachFlow: "Run device_inventory for backend ios-device, confirm the UDID is visible as a network device through xctrace, then call device_attach with connection=wifi.",
        ...details,
    };
}

/** @param {IosWirelessInventory} inventory @param {unknown} udid */
export function iosWirelessStatus(inventory, udid) {
    const devices = inventory.devices || [];
    const selected = udid ? devices.find(device => device.udid === udid) || null : null;
    return {
        ok: true,
        backend: "ios-device",
        provider: "xcrun-xctrace",
        supportedActions: ["status"],
        unsupportedActions: ["pair", "connect", "usb-tcpip"],
        inventory,
        udid: udid || null,
        selected,
        networkVisible: selected ? selected.connection === "wifi" : devices.some(device => device.connection === "wifi"),
        attachFlow: "If the target UDID is visible as a network device, call device_attach with backend=ios-device, udid, and connection=wifi.",
        notes: [
            "Apple trust, Developer Mode, and Xcode network pairing must be completed on the macOS host",
            "CCC does not bypass or automate the Trust This Computer prompt",
            "Physical-device ownership is still claimed by device_attach or broker attach",
        ],
    };
}
