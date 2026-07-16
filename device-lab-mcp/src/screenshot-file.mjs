import { textResult } from "./responses.mjs";
import { readDeviceLabBinaryFile } from "./state/state-file.mjs";

export const DEVICE_SCREENSHOT_LIMIT_BYTES = 32 * 1024 * 1024;

export function screenshotFileResult(file, prefix) {
    try {
        const bytes = readDeviceLabBinaryFile(file, prefix, DEVICE_SCREENSHOT_LIMIT_BYTES);
        if (!bytes || bytes.length === 0) return textResult(false, `${prefix}-output-missing`);
        return { content: [{ type: "image", data: bytes.toString("base64"), mimeType: "image/png" }] };
    } catch (error) {
        return textResult(false, error?.code || `${prefix}-output-invalid`);
    }
}
