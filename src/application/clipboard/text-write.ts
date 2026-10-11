import type { ClipboardBytes, ClipboardPlatform, ClipboardSnapshotState } from "../../domain/clipboard/snapshot.js";
import { CLIPBOARD_WRITE_TIMEOUT_MS, isValidClipboardText } from "../../domain/clipboard/text-write.js";
import type { ClipboardTextWritePorts } from "../../ports/clipboard/text-write.js";
import { invalidateClipboardCache } from "./snapshot.js";

export function createClipboardTextWriter<Bytes extends ClipboardBytes>(
    ports: ClipboardTextWritePorts<Bytes>,
    state: ClipboardSnapshotState<Bytes>,
) {
    async function writeClipboardText(text: string, plat: ClipboardPlatform): Promise<void> {
        const bytes = ports.encodeText(text);
        if (!isValidClipboardText(text, bytes.length, () => ports.decodeText(bytes))) {
            throw new Error("Invalid clipboard text");
        }
        const prepared = ports.prepareWriter(bytes, plat);
        if (prepared.kind === "unavailable") throw new Error("Clipboard writer unavailable");
        invalidateClipboardCache(state);
        try {
            const result = await prepared.write(CLIPBOARD_WRITE_TIMEOUT_MS);
            if (result.kind === "failed") throw new Error("Clipboard write failed");
        } finally {
            invalidateClipboardCache(state);
        }
    }
    return writeClipboardText;
}
