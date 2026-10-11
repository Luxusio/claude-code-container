import { textResult } from "./responses.mjs";
import { readDeviceLabBinaryFile } from "./state/state-file.mjs";

export const DEVICE_SCREENSHOT_LIMIT_BYTES = 32 * 1024 * 1024;

/** @typedef {{kind:"image",data:string}|{kind:"missing",message:string}|{kind:"invalid",message:string}} ScreenshotFileFacts */
/** @param {string} file @param {string} prefix @returns {ScreenshotFileFacts} */
export function readScreenshotFile(file, prefix) {
    try {
        const bytes = readDeviceLabBinaryFile(file, prefix, DEVICE_SCREENSHOT_LIMIT_BYTES);
        if (!bytes || bytes.length === 0) return { kind: "missing", message: `${prefix}-output-missing` };
        return { kind: "image", data: bytes.toString("base64") };
    } catch (error) {
        return { kind: "invalid", message: error?.code || `${prefix}-output-invalid` };
    }
}

export function screenshotFileResult(file, prefix) {
    const facts = readScreenshotFile(file, prefix);
    return facts.kind === "image"
        ? { content: [{ type: "image", data: facts.data, mimeType: "image/png" }] }
        : textResult(false, facts.message);
}
