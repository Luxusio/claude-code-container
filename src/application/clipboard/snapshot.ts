import {
    CACHE_TTL_MS, shouldReuseClipboardCache,
    type CapturedClipboardSnapshot, type ClipboardBytes, type ClipboardPlatform,
    type ClipboardSnapshot, type ClipboardSnapshotState,
} from "../../domain/clipboard/snapshot.js";
import type { ClipboardSnapshotPorts } from "../../ports/clipboard/snapshot.js";

export function createClipboardSnapshotState<Bytes>(): ClipboardSnapshotState<Bytes> {
    return { cache: null, generation: 0, readQueue: Promise.resolve() };
}
export function invalidateClipboardCache<Bytes>(state: ClipboardSnapshotState<Bytes>): void {
    state.generation += 1;
    state.cache = null;
}
function withCopiedImageFileTextFallback<Bytes>(text: Bytes | null): CapturedClipboardSnapshot<Bytes> {
    return {
        targets: text ? ["text/plain", "application/x-ccc-copied-image-file"] : [],
        text,
        imagePng: null,
        imageBmp: null,
    };
}
export function buildImageFileClipboardFallbackFromPaths<Bytes>(
    paths: string[],
    readImageFile: (filePath: string) => Bytes | null,
    copyImageFile: (filePath: string) => Bytes | null,
): CapturedClipboardSnapshot<Bytes> {
    for (const filePath of paths) {
        const image = readImageFile(filePath);
        if (image) {
            return {
                targets: ["image/png", "application/x-ccc-image-file"],
                text: null,
                imagePng: image,
                imageBmp: null,
            };
        }
    }
    for (const filePath of paths) {
        const copiedPath = copyImageFile(filePath);
        if (copiedPath) return withCopiedImageFileTextFallback(copiedPath);
    }
    return withCopiedImageFileTextFallback<Bytes>(null);
}

export function createClipboardSnapshotReader<Bytes extends ClipboardBytes>(
    ports: ClipboardSnapshotPorts<Bytes>,
    state: ClipboardSnapshotState<Bytes>,
) {
    function fileFallback(paths: string[]): CapturedClipboardSnapshot<Bytes> {
        return buildImageFileClipboardFallbackFromPaths(paths, path => ports.readImageFile(path), path => ports.copyImageFile(path));
    }
    async function readMarker(plat: ClipboardPlatform): Promise<string | null> {
        const observation = await ports.readChangeMarker(plat);
        if (observation.kind === "unavailable") throw ports.createReadError();
        return observation.marker;
    }
    async function capture(plat: ClipboardPlatform): Promise<CapturedClipboardSnapshot<Bytes>> {
        const observation = await ports.capture(plat);
        if (observation.kind === "unavailable") throw ports.createReadError();
        const { snapshot, fileReferences, textImagePaths } = observation;
        if (snapshot.imagePng || snapshot.imageBmp) return snapshot;
        for (const paths of [fileReferences, textImagePaths]) {
            const fallback = fileFallback(paths);
            if (fallback.targets.length > 0) return { ...fallback, marker: snapshot.marker };
        }
        return snapshot;
    }
    async function readClipboardSnapshot(plat: ClipboardPlatform, forceRefresh: boolean): Promise<ClipboardSnapshot<Bytes>> {
        const now = ports.now();
        const marker = await readMarker(plat);
        const cached = state.cache;
        const negativeCacheFresh = cached && (cached.imagePng || cached.imageBmp || now - cached.timestamp < CACHE_TTL_MS);
        if (cached && negativeCacheFresh && !forceRefresh && shouldReuseClipboardCache(cached, now, marker)) return cached;

        if (plat === "windows" || plat === "wsl" || plat === "darwin") {
            for (let attempt = 0; attempt < 3; attempt += 1) {
                const snapshot = await capture(plat);
                const after = await readMarker(plat);
                if (snapshot.marker == null) {
                    if (plat !== "darwin" || marker !== null || after !== null) throw ports.createReadError();
                    return { timestamp: ports.now(), ...snapshot, marker: null };
                }
                if (snapshot.marker === after) return { timestamp: ports.now(), ...snapshot };
            }
            throw ports.createReadError();
        }
        return { timestamp: now, ...await capture(plat), marker: null };
    }
    async function readAndCacheClipboard(plat: ClipboardPlatform, forceRefresh: boolean): Promise<ClipboardSnapshot<Bytes>> {
        while (true) {
            const generation = state.generation;
            const snapshot = await readClipboardSnapshot(plat, forceRefresh);
            if (generation !== state.generation) continue;
            state.cache = snapshot;
            return snapshot;
        }
    }
    function getCachedClipboardSnapshot(plat: ClipboardPlatform, forceRefresh = false): Promise<ClipboardSnapshot<Bytes>> {
        const read = state.readQueue.then(() => readAndCacheClipboard(plat, forceRefresh));
        state.readQueue = read.catch(() => {});
        return read;
    }
    return getCachedClipboardSnapshot;
}
