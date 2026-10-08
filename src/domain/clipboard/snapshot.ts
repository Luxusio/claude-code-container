export type ClipboardPlatform = "darwin" | "linux-x11" | "linux-wayland" | "wsl" | "windows" | "unsupported";

export interface ClipboardBytes { readonly length: number }
export interface ClipboardSnapshot<Bytes> {
    timestamp: number;
    marker?: string | null;
    targets: string[];
    text: Bytes | null;
    imagePng: Bytes | null;
    imageBmp: Bytes | null;
}
export type CapturedClipboardSnapshot<Bytes> = Omit<ClipboardSnapshot<Bytes>, "timestamp">;
export interface ClipboardSnapshotState<Bytes> {
    cache: ClipboardSnapshot<Bytes> | null;
    generation: number;
    readQueue: Promise<unknown>;
}
export const CACHE_TTL_MS = 200;
export function shouldReuseClipboardCache(
    cache: Pick<ClipboardSnapshot<unknown>, "timestamp" | "marker"> | null,
    now: number,
    marker: string | null,
    ttlMs = CACHE_TTL_MS,
): boolean {
    if (!cache) return false;
    if (marker !== null) return cache.marker === marker;
    return now - cache.timestamp < ttlMs;
}
const IMAGE_MIME_TYPES = [
    "image/png", "image/jpeg", "image/jpg", "image/gif",
    "image/webp", "image/avif", "image/tiff", "image/bmp",
];
export function isSupportedImageTarget(target: string): boolean {
    return IMAGE_MIME_TYPES.includes(target.toLowerCase());
}
export function buildImageMimeReadOrder(targets: string[], preferred: "png" | "bmp" = "png"): string[] {
    const preferredMime = preferred === "bmp" ? "image/bmp" : "image/png";
    const ordered = [
        preferredMime,
        ...targets.map((target) => target.toLowerCase()).filter(isSupportedImageTarget),
        ...IMAGE_MIME_TYPES,
    ];
    return [...new Set(ordered)];
}
