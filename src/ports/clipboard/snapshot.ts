import type { CapturedClipboardSnapshot, ClipboardBytes, ClipboardPlatform } from "../../domain/clipboard/snapshot.js";

export type ClipboardMarkerObservation =
    | { kind: "observed"; marker: string | null }
    | { kind: "unavailable" };

export type ClipboardCaptureObservation<Bytes> =
    | { kind: "captured"; snapshot: CapturedClipboardSnapshot<Bytes>; fileReferences: string[]; textImagePaths: string[] }
    | { kind: "unavailable" };

export interface ClipboardSnapshotPorts<Bytes extends ClipboardBytes> {
    now(): number;
    readChangeMarker(platform: ClipboardPlatform): Promise<ClipboardMarkerObservation>;
    capture(platform: ClipboardPlatform): Promise<ClipboardCaptureObservation<Bytes>>;
    readImageFile(filePath: string): Bytes | null;
    copyImageFile(filePath: string): Bytes | null;
    createReadError(): Error;
}
