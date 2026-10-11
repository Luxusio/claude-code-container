import type { ClipboardBytes, ClipboardPlatform } from "../../domain/clipboard/snapshot.js";

export type ClipboardTextWriteResult = { kind: "written" } | { kind: "failed" };

export type PreparedClipboardTextWrite =
    | { kind: "unavailable" }
    | { kind: "ready"; write(timeoutMs: number): Promise<ClipboardTextWriteResult> };

export interface ClipboardTextWritePorts<Bytes extends ClipboardBytes> {
    encodeText(text: string): Bytes;
    decodeText(bytes: Bytes): string;
    prepareWriter(bytes: Bytes, platform: ClipboardPlatform): PreparedClipboardTextWrite;
}
