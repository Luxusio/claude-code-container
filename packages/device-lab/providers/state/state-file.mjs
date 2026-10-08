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

export function readDeviceLabTextFile(file, prefix, limitBytes = DEVICE_LAB_STATE_FILE_LIMIT_BYTES) {
    return readStateFileText({
        read: () => readDeviceLabBinaryFile(file, prefix, limitBytes),
        decode: bytes => bytes.toString("utf8"),
    });
}

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
