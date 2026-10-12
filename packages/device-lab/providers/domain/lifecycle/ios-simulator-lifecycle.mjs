/** @param {string} operation */
export function iosLifecycleClaimStatus(operation) {
    return operation === "delete" ? "deleting" : operation === "stop" ? "stopping" : "starting";
}

/** @param {{name?: string, udid?: string}[]} devices
 * @param {{udid?: string | null, simulatorName?: string}} device
 */
export function selectIosSimulatorMatches(devices, device) {
    const simulators = devices;
    return device.udid
        ? simulators.filter((item) => item?.udid === device.udid)
        : simulators.filter((item) => item?.name === device.simulatorName);
}
