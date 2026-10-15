import { parseAndroidWifiEndpoint } from "../domain/android-wireless.mjs";
/** @typedef {import('../ports/device-observation.mjs').SimulatorInventory} SimulatorInventory */
/** @typedef {{status:number|null,stdout?:string,stderr?:string,signal?:string|null,error?:{message?:string}|null}} InventoryCommand */
/** @typedef {{value:SimulatorInventory,error?:undefined}|{error:InventoryCommand,value?:undefined}} NativeSimulatorObservation */

/** @param {unknown} text */
export function parseAdbDevices(text) {
    return String(text || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("List of devices"))
        .map((line) => {
            const [serial, state, ...detailParts] = line.split(/\s+/);
            const details = Object.fromEntries(detailParts.map((part) => {
                const index = part.indexOf(":");
                return index > 0 ? [part.slice(0, index), part.slice(index + 1)] : [part, true];
            }));
            const emulator = serial?.startsWith("emulator-") || false;
            const connection = !emulator && parseAndroidWifiEndpoint(serial) ? "wifi" : "usb";
            return { serial, state: state || "unknown", details, emulator, connection };
        })
        .filter((device) => device.serial);
}

/** @param {InventoryCommand} result
 * @returns {import('../ports/device-observation.mjs').HostDevices<import('../ports/device-observation.mjs').AndroidHostDevice>} */
export function androidHostDevices(result) {
    if (result.status !== 0) return {
        available: false, missing: [], devices: [],
        error: result.stderr || result.stdout || `exit ${result.status}`,
    };
    return { available: true, missing: [], devices: parseAdbDevices(result.stdout) };
}

/** @param {InventoryCommand} result
 * @returns {import('../ports/device-observation.mjs').HostAvds} */
export function androidHostAvds(result) {
    if (result.status !== 0) return {
        available: false, missing: [], avds: [],
        error: result.stderr || result.stdout || `exit ${result.status}`,
    };
    return { available: true, missing: [], avds: (result.stdout || "").split(/\r?\n/).map(line => line.trim()).filter(Boolean) };
}

/** Keep decoded SDK data opaque to application reconciliation.
 * @param {NativeSimulatorObservation} result
 * @returns {import('../ports/device-observation.mjs').SimulatorObservation} */
export function simulatorObservation(result) {
    return {
        ok: !result.error,
        detail: result.error ? result.error.stderr || result.error.stdout || `exit ${result.error.status}` : "",
        evidence: result,
    };
}

/** Backend-only projection of the captured catalog; never runs another query.
 * @param {import('../ports/device-observation.mjs').Prerequisites} facts
 * @param {import('../ports/device-observation.mjs').SimulatorObservation} [observation] */
export function presentSimulatorCatalog(facts, observation) {
    if (!facts.available) return { available: false, missing: facts.missing, devices: {}, runtimes: [], deviceTypes: [] };
    if (observation && !observation.ok) return {
        available: false, missing: [], devices: {}, runtimes: [], deviceTypes: [], error: observation.detail,
    };
    const inventory = observation ? /** @type {{value:SimulatorInventory}} */ (observation.evidence).value : {};
    return {
        available: true, missing: [], devices: inventory.devices || {}, runtimes: inventory.runtimes || [],
        deviceTypes: inventory.devicetypes || inventory.deviceTypes || [],
    };
}
