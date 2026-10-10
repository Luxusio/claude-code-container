/** @typedef {{ok: true, port: number} | {ok: false, error: string, detail?: string, allowed?: string}} AndroidEmulatorPortAllocation */
export const ANDROID_EMULATOR_PORT_MIN = 5554;
export const ANDROID_EMULATOR_PORT_MAX = 5682;

/** @param {unknown} port */
export function validAndroidEmulatorPort(port) {
    return Number.isInteger(port)
        && /** @type {number} */ (port) >= ANDROID_EMULATOR_PORT_MIN
        && /** @type {number} */ (port) <= ANDROID_EMULATOR_PORT_MAX
        && /** @type {number} */ (port) % 2 === 0;
}

/** @param {unknown} requestedPort
 * @returns {Extract<AndroidEmulatorPortAllocation, {ok: false}> | null} */
export function validateAndroidEmulatorPortRequest(requestedPort) {
    if (requestedPort !== undefined && !validAndroidEmulatorPort(requestedPort)) {
        return {
            ok: false,
            error: "invalid-android-emulator-port",
            allowed: `even integer ${ANDROID_EMULATOR_PORT_MIN}-${ANDROID_EMULATOR_PORT_MAX}`,
        };
    }
    return null;
}

/** The native facade owns inventory and hashing; this domain owns pool policy.
 * @param {Set<number>} used
 * @param {number | undefined} requestedPort
 * @param {number | undefined} initialSeed
 * @returns {AndroidEmulatorPortAllocation} */
export function selectAndroidEmulatorPort(used, requestedPort, initialSeed) {
    if (requestedPort !== undefined) {
        return used.has(requestedPort)
            ? { ok: false, error: "android-emulator-port-conflict", detail: `port-${requestedPort}-already-allocated` }
            : { ok: true, port: requestedPort };
    }
    const slotCount = ((ANDROID_EMULATOR_PORT_MAX - ANDROID_EMULATOR_PORT_MIN) / 2) + 1;
    const initialSlot = /** @type {number} */ (initialSeed) % slotCount;
    for (let offset = 0; offset < slotCount; offset += 1) {
        const port = ANDROID_EMULATOR_PORT_MIN + (((initialSlot + offset) % slotCount) * 2);
        if (!used.has(port)) return { ok: true, port };
    }
    return { ok: false, error: "android-emulator-port-pool-exhausted" };
}

/** @param {Set<number>} used
 * @param {Iterable<number>} additionalUsedPorts */
export function addAndroidEmulatorUsedPorts(used, additionalUsedPorts) {
    for (const port of additionalUsedPorts) {
        if (validAndroidEmulatorPort(port)) used.add(port);
    }
}
