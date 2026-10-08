import {
    DEVICE_LAB_STATE_FILE_LIMIT_BYTES,
    readDeviceLabBinaryFile,
} from "./device-lab/adapters/state/state-file.js";
import { DeviceLabStateFileError } from "./device-lab/domain/state-file-error.js";
import { readStateFileText, validateStateFileContent } from "../providers/application/state-file-read.mjs";

export {
    DEVICE_LAB_STATE_FILE_LIMIT_BYTES,
    readDeviceLabBinaryFile,
    readDeviceLabBinaryFileWithinRoot,
    withDeviceLabReadableFile,
    assertDeviceLabPathWithinRoot,
    writeDeviceLabBinaryFile,
} from "./device-lab/adapters/state/state-file.js";
export { DeviceLabStateFileError };

export function readDeviceLabTextFile(
    file: string,
    prefix: string,
    limitBytes = DEVICE_LAB_STATE_FILE_LIMIT_BYTES,
): string | null {
    return readStateFileText({
        read: () => readDeviceLabBinaryFile(file, prefix, limitBytes),
        decode: bytes => bytes.toString("utf8"),
    });
}

export function readDeviceLabStateFile<T>(
    file: string,
    validate: (value: unknown) => T,
    prefix: string,
    limitBytes = DEVICE_LAB_STATE_FILE_LIMIT_BYTES,
): T | null {
    // Native faults and missing content precede the legacy outer classifier.
    const bytes = readDeviceLabBinaryFile(file, prefix, limitBytes);
    if (bytes === null) return null;
    try {
        return validateStateFileContent(bytes, {
            read: () => bytes,
            decode: content => content.toString("utf8"),
            // JS evaluates JSON.parse before the decode argument and keeps JSON
            // as receiver; the application must not move decoding ahead of it.
            parse: decode => JSON.parse(decode()),
            validate,
            isStateError: error => error instanceof DeviceLabStateFileError,
            invalidState: cause => new DeviceLabStateFileError(`${prefix}-state-invalid`, { cause }),
        });
    } catch (error) {
        // TS has this additional classifier; shared provider reads do not.
        if (error instanceof DeviceLabStateFileError) throw error;
        throw new DeviceLabStateFileError(`${prefix}-state-invalid`, { cause: error });
    }
}

export function deviceLabStateFileErrorCode(error: unknown): string | null {
    return error instanceof DeviceLabStateFileError ? error.code : null;
}
