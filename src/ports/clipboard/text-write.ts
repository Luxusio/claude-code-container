import type { ClipboardBytes, ClipboardPlatform } from "../../domain/clipboard/snapshot.js";

export interface ClipboardTextWritePorts<Bytes extends ClipboardBytes, PreparedWriter, Writer, Timer> {
    encodeText(text: string): Bytes;
    decodeText(bytes: Bytes): string;
    prepareWriter(bytes: Bytes, platform: ClipboardPlatform): PreparedWriter;
    launchWriter(prepared: PreparedWriter, platform: ClipboardPlatform): Writer;
    scheduleTimeout(callback: () => void, timeoutMs: number): Timer;
    cancelReadTimer(timer: Timer): undefined;
    onWriterError(writer: Writer, callback: () => void): undefined;
    onWriterExit(writer: Writer, callback: (code: number | null) => void): undefined;
    onInputError(writer: Writer, callback: () => void): undefined;
    endInput(writer: Writer, prepared: PreparedWriter): undefined;
    killWriter(writer: Writer): undefined;
}
