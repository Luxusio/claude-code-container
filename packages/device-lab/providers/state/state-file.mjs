import { DEVICE_LAB_STATE_FILE_LIMIT_BYTES, readDeviceLabBinaryFile } from "../adapters/state/state-file.mjs";
import { DeviceLabStateFileError } from "../domain/state-file-error.mjs";
import { readStateFileText, readValidatedStateFile } from "../application/state-file-read.mjs";

export {
    DEVICE_LAB_STATE_FILE_LIMIT_BYTES,
    readDeviceLabBinaryFile,
    withDeviceLabReadableFile,
    assertDeviceLabPathWithinRoot,
} from "../adapters/state/state-file.mjs";
export { DeviceLabStateFileError };

/** @param {string} file @param {string} prefix @param {number} [limitBytes] @returns {string | null} */
export function readDeviceLabTextFile(file, prefix, limitBytes = DEVICE_LAB_STATE_FILE_LIMIT_BYTES) {
    return readStateFileText({
        read: () => readDeviceLabBinaryFile(file, prefix, limitBytes),
        decode: bytes => bytes.toString("utf8"),
    });
}

/**
 * @template Value
 * @param {string} file
 * @param {(value: unknown) => Value} validate
 * @param {string} prefix
 * @param {number} [limitBytes]
 * @returns {Value | null}
 */
export function readDeviceLabStateFile(file, validate, prefix, limitBytes = DEVICE_LAB_STATE_FILE_LIMIT_BYTES) {
    return readValidatedStateFile({
        read: () => readDeviceLabBinaryFile(file, prefix, limitBytes),
        decode: bytes => bytes.toString("utf8"),
        // This expression captures JSON.parse before evaluating decode(), with
        // JSON as receiver. Missing content never enters this port.
        parse: decode => JSON.parse(decode()),
        validate,
        isStateError: error => error instanceof DeviceLabStateFileError,
        invalidState: cause => new DeviceLabStateFileError(`${prefix}-state-invalid`, { cause }),
    });
}
