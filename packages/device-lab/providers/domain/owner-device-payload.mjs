/**
 * @typedef {{id: string} & Record<string, unknown>} ValidatedOwnerDeviceRecord
 * @typedef {{kind: 'valid', devices: ValidatedOwnerDeviceRecord[]} | {kind: 'invalid'}} OwnerDevicePayloadValidation
 */

/**
 * Validate persisted device identities without reading storage or changing data.
 * The adapter supplies its existing public ID pattern and maps invalid to its
 * own error class. Filesystem safety and serialized byte limits stay outside.
 * @param {unknown} parsed
 * @param {RegExp} idPattern
 * @returns {OwnerDevicePayloadValidation}
 */
export function validateOwnerDevicePayload(parsed, idPattern) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "invalid" };
    const devices = /** @type {{devices?: unknown}} */ (parsed).devices;
    if (!Array.isArray(devices)) return { kind: "invalid" };
    const ids = new Set();
    const avdNames = new Set();
    for (const value of devices) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return { kind: "invalid" };
        const device = /** @type {{id?: unknown, avdName?: unknown}} */ (value);
        const id = device.id;
        if (typeof id !== "string" || !idPattern.test(id) || ids.has(id)) return { kind: "invalid" };
        ids.add(id);
        const avdName = device.avdName;
        if (avdName !== undefined) {
            if (typeof avdName !== "string" || avdName.length === 0 || avdName.length > 128 || avdNames.has(avdName)) {
                return { kind: "invalid" };
            }
            avdNames.add(avdName);
        }
    }
    // Every element passed the object and string-ID guards above.
    return { kind: "valid", devices: /** @type {ValidatedOwnerDeviceRecord[]} */ (devices) };
}
