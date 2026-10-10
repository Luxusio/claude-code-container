/** @param {string} operation */
export function iosLifecycleClaimStatus(operation) {
    return operation === "delete" ? "deleting" : operation === "stop" ? "stopping" : "starting";
}

/** @param {unknown} value */
export function boundedSimulatorIdentityDetail(value) {
    const text = String(value || "").trim();
    return text.length > 4096 ? `${text.slice(0, 4096)}...` : text;
}

/** @param {{status: number | null, stderr: string, stdout: string}} result
 * @param {"boot" | "shutdown" | "delete"} operation
 */
export function iosSimulatorCommandFailed(result, operation) {
    return result.status !== 0 && !String(result.stderr || result.stdout).includes(
        operation === "boot" ? "Unable to boot device in current state: Booted"
            : operation === "shutdown" ? "Unable to shutdown device in current state: Shutdown"
                : "Invalid device");
}

/** @param {Record<string, {name?: string, udid?: string}[]> | undefined} devices
 * @param {{udid?: string | null, simulatorName?: string}} device
 */
export function selectIosSimulatorMatches(devices, device) {
    const simulators = Object.values(devices || {}).flatMap((items) => Array.isArray(items) ? items : []);
    return device.udid
        ? simulators.filter((item) => item?.udid === device.udid)
        : simulators.filter((item) => item?.name === device.simulatorName);
}
