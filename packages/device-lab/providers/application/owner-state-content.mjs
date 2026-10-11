import { validateOwnerDevicePayload } from '../domain/owner-device-payload.mjs';

/** @param {import('../ports/owner-state-content.mjs').OwnerStateContentPorts} ports */
export function createOwnerStateContent(ports) {
    /** @param {unknown} parsed */
    function validatedDevices(parsed) {
        const result = validateOwnerDevicePayload(parsed, ports.idPattern);
        if (result.kind === 'invalid') throw ports.stateError('owner-devices-state-invalid');
        return result.devices;
    }
    /** @param {()=>string} readText @returns {unknown[]} */
    function read(readText) {
        /** @type {unknown} */
        let parsed;
        try {
            parsed = JSON.parse(readText());
        } catch (error) {
            if (ports.isStateError(error)) throw error;
            throw ports.stateError('owner-devices-state-invalid', error);
        }
        return validatedDevices(parsed);
    }
    /** @param {unknown[]} devices @param {number} limitBytes @returns {undefined} */
    function assertWritable(devices, limitBytes) {
        validatedDevices({ devices });
        if (ports.byteLength(JSON.stringify({ devices }, null, 2)) > limitBytes) {
            throw ports.stateError('owner-devices-file-too-large');
        }
        return undefined;
    }
    return { read, assertWritable };
}
