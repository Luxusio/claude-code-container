/**
 * Classify present content. Native read failures are outside this boundary.
 * No ports are eagerly destructured: parsing captures its native callee before
 * invoking the decoder thunk, and validation retains a bare-call receiver.
 * @template Bytes, Value
 * @param {Bytes} bytes
 * @param {import('../ports/state-file.mjs').StateFileReadPorts<Bytes, Value>} ports
 * @returns {Value}
 */
export function validateStateFileContent(bytes, ports) {
    let parsed;
    try {
        parsed = ports.parse(() => ports.decode(bytes));
    } catch (error) {
        if (ports.isStateError(error)) throw error;
        throw ports.invalidState(error);
    }
    try {
        const validate = ports.validate;
        return validate(parsed);
    } catch (error) {
        if (ports.isStateError(error)) throw error;
        throw ports.invalidState(error);
    }
}

/**
 * Missing content bypasses decode, parse and validation.
 * @template Bytes, Value
 * @param {import('../ports/state-file.mjs').StateFileReadPorts<Bytes, Value>} ports
 * @returns {Value | null}
 */
export function readValidatedStateFile(ports) {
    const bytes = ports.read();
    if (bytes === null) return null;
    return validateStateFileContent(bytes, ports);
}

/**
 * Text reads propagate native read and decoder faults unchanged.
 * @template Bytes
 * @param {{read: () => Bytes | null, decode: (bytes: Bytes) => string}} ports
 * @returns {string | null}
 */
export function readStateFileText(ports) {
    const bytes = ports.read();
    return bytes === null ? null : ports.decode(bytes) ?? null;
}
