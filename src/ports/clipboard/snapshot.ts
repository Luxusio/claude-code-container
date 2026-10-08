import type { CapturedClipboardSnapshot, ClipboardBytes, ClipboardPlatform } from "../../domain/clipboard/snapshot.js";

export interface ClipboardCommandCapture<Bytes> { stdout: Bytes; status: number }
export interface ClipboardSnapshotPorts<Bytes extends ClipboardBytes> {
    now(): number;
    readChangeMarker(platform: ClipboardPlatform): Promise<string | null>;
    readWindowsCapture(): Promise<CapturedClipboardSnapshot<Bytes>>;
    readDarwinFrame(): Promise<string | null>;
    parseDarwinCapture(output: string): CapturedClipboardSnapshot<Bytes> | null;
    readDarwinLegacyImage(): Promise<ClipboardCommandCapture<Bytes>>;
    readDarwinLegacyText(): Promise<ClipboardCommandCapture<Bytes>>;
    readDarwinPngpaste(): ClipboardCommandCapture<Bytes>;
    parseAppleScriptImage(bytes: Bytes): Bytes | null;
    readDarwinFileReferenceData(): ClipboardCommandCapture<Bytes>;
    readLinuxUriData(platform: ClipboardPlatform, target: string): ClipboardCommandCapture<Bytes>;
    decodeText(bytes: Bytes, encoding: "utf8" | "utf-8"): string;
    parseFileUriList(text: string): string[];
    parseImagePathText(text: string): string[];
    readTargets(platform: ClipboardPlatform): string[];
    readText(platform: ClipboardPlatform): Bytes | null;
    readImage(platform: ClipboardPlatform, format: "png" | "bmp", targets: string[]): Bytes | null;
    readImageFile(filePath: string): Bytes | null;
    copyImageFile(filePath: string): Bytes | null;
    createReadError(): Error;
}
