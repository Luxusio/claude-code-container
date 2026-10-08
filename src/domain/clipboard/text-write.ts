export const MAX_CLIPBOARD_TEXT_BYTES = 1048576;
export const CLIPBOARD_WRITE_TIMEOUT_MS = 5000;

export function isValidClipboardText(text: string, byteLength: number, decode: () => string): boolean {
    return !(byteLength > MAX_CLIPBOARD_TEXT_BYTES || text.includes("\0") || decode() !== text);
}
