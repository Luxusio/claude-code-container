import type { ClipboardBytes, ClipboardPlatform, ClipboardSnapshotState } from "../../domain/clipboard/snapshot.js";
import { CLIPBOARD_WRITE_TIMEOUT_MS, isValidClipboardText } from "../../domain/clipboard/text-write.js";
import type { ClipboardTextWritePorts } from "../../ports/clipboard/text-write.js";
import { invalidateClipboardCache } from "./snapshot.js";

export function createClipboardTextWriter<Bytes extends ClipboardBytes, PreparedWriter, Writer, Timer>(
    ports: ClipboardTextWritePorts<Bytes, PreparedWriter, Writer, Timer>,
    state: ClipboardSnapshotState<Bytes>,
) {
    async function writeClipboardText(text: string, plat: ClipboardPlatform): Promise<void> {
        const bytes = ports.encodeText(text);
        if (!isValidClipboardText(text, bytes.length, () => ports.decodeText(bytes))) {
            throw new Error("Invalid clipboard text");
        }
        const prepared = ports.prepareWriter(bytes, plat);
        invalidateClipboardCache(state);
        try {
            await new Promise<void>((resolve, reject) => {
                const child = ports.launchWriter(prepared, plat);
                let settled = false;
                const finish = (success: boolean) => {
                    if (settled) return;
                    settled = true;
                    ports.clearTimeout(timer);
                    if (success) resolve();
                    else reject(new Error("Clipboard write failed"));
                };
                const timer = ports.scheduleTimeout(() => {
                    ports.killWriter(child);
                    finish(false);
                }, CLIPBOARD_WRITE_TIMEOUT_MS);
                ports.onWriterError(child, () => finish(false));
                ports.onWriterExit(child, (code) => finish(code === 0));
                ports.onInputError(child, () => {
                    ports.killWriter(child);
                    finish(false);
                });
                ports.endInput(child, prepared);
            });
        } finally {
            invalidateClipboardCache(state);
        }
    }
    return writeClipboardText;
}
