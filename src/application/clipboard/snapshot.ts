import {
    CACHE_TTL_MS, isSupportedImageTarget, shouldReuseClipboardCache,
    type CapturedClipboardSnapshot, type ClipboardBytes, type ClipboardPlatform,
    type ClipboardSnapshot, type ClipboardSnapshotState,
} from "../../domain/clipboard/snapshot.js";
import type { ClipboardSnapshotPorts } from "../../ports/clipboard/snapshot.js";

export function createClipboardSnapshotState<Bytes>(): ClipboardSnapshotState<Bytes> {
    return { cache: null, generation: 0, readQueue: Promise.resolve() };
}
export function invalidateClipboardCache<Bytes>(state: ClipboardSnapshotState<Bytes>): undefined {
    state.generation += 1;
    state.cache = null;
    return undefined;
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
        return buildImageFileClipboardFallbackFromPaths(paths, ports.readImageFile, ports.copyImageFile);
    }
    function darwinFileFallback(): CapturedClipboardSnapshot<Bytes> {
        const r = ports.readDarwinFileReferenceData();
        if (r.status !== 0 || r.stdout.length === 0) return withCopiedImageFileTextFallback<Bytes>(null);
        return fileFallback(ports.decodeText(r.stdout, "utf-8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
    }
    function linuxFileFallback(plat: ClipboardPlatform, targets: string[]): CapturedClipboardSnapshot<Bytes> {
        const candidateTargets = [
            ...targets.filter((target) => target === "text/uri-list" || target === "x-special/gnome-copied-files"),
            "text/uri-list",
            "x-special/gnome-copied-files",
        ];
        for (const target of [...new Set(candidateTargets)]) {
            const r = ports.readLinuxUriData(plat, target);
            if (r.status === 0 && r.stdout.length > 0) {
                const paths = ports.parseFileUriList(ports.decodeText(r.stdout, "utf-8"));
                if (paths.length > 0) return fileFallback(paths);
            }
        }
        return fileFallback([]);
    }
    async function readAllClipboardDarwin(): Promise<CapturedClipboardSnapshot<Bytes>> {
        const nativeOutput = await ports.readDarwinFrame();
        if (nativeOutput !== null) {
            const parsed = ports.parseDarwinCapture(nativeOutput);
            if (!parsed) throw ports.createReadError();
            if (parsed.imagePng) return parsed;
            const converted = ports.readDarwinPngpaste();
            if (converted.status === 0 && converted.stdout.length > 0) {
                return { ...parsed, targets: [...new Set([...parsed.targets, "image/png"])], imagePng: converted.stdout };
            }
            const fallback = darwinFileFallback();
            if (fallback.targets.length > 0) return { ...fallback, marker: parsed.marker };
            if (parsed.text) {
                const textFallback = fileFallback(ports.parseImagePathText(ports.decodeText(parsed.text, "utf8")));
                if (textFallback.targets.length > 0) return { ...textFallback, marker: parsed.marker };
            }
            return parsed;
        }
        const [imgResult, textResult] = await Promise.all([
            ports.readDarwinLegacyImage(),
            ports.readDarwinLegacyText(),
        ]);
        if (imgResult.status !== 0 || textResult.status !== 0) throw ports.createReadError();
        const targets: string[] = [];
        let imagePng: Bytes | null = null;
        let text: Bytes | null = null;
        if (imgResult.status === 0 && imgResult.stdout.length > 0) {
            imagePng = ports.parseAppleScriptImage(imgResult.stdout);
        }
        if (!imagePng) {
            const r = ports.readDarwinPngpaste();
            if (r.status === 0 && r.stdout.length > 0) imagePng = r.stdout;
        }
        if (imagePng) targets.push("image/png");
        if (!imagePng) {
            const fallback = darwinFileFallback();
            if (fallback.targets.length > 0) return fallback;
        }
        if (textResult.status === 0 && textResult.stdout.length > 0) {
            text = textResult.stdout;
            if (!imagePng) {
                const fallback = fileFallback(ports.parseImagePathText(ports.decodeText(text, "utf-8")));
                if (fallback.targets.length > 0) return fallback;
            }
            targets.push("text/plain");
        }
        return { targets, text, imagePng, imageBmp: null };
    }
    async function readClipboardSnapshot(plat: ClipboardPlatform, forceRefresh: boolean): Promise<ClipboardSnapshot<Bytes>> {
        const now = ports.now();
        const marker = await ports.readChangeMarker(plat);
        const cached = state.cache;
        const negativeCacheFresh = cached && (cached.imagePng || cached.imageBmp || now - cached.timestamp < CACHE_TTL_MS);
        if (cached && negativeCacheFresh && !forceRefresh && shouldReuseClipboardCache(cached, now, marker)) return cached;

        if (plat === "windows" || plat === "wsl" || plat === "darwin") {
            for (let attempt = 0; attempt < 3; attempt += 1) {
                const snapshot = plat === "darwin" ? await readAllClipboardDarwin() : await ports.readWindowsCapture();
                const after = await ports.readChangeMarker(plat);
                if (snapshot.marker == null) {
                    if (plat !== "darwin" || marker !== null || after !== null) throw ports.createReadError();
                    return { timestamp: ports.now(), ...snapshot, marker: null };
                }
                if (snapshot.marker === after) return { timestamp: ports.now(), ...snapshot };
            }
            throw ports.createReadError();
        }
        const targets = ports.readTargets(plat);
        const hasImage = targets.some(isSupportedImageTarget);
        const hasText = targets.some(t => t.includes("text/plain") || t === "STRING" || t === "UTF8_STRING");
        const text = hasText ? ports.readText(plat) : null;
        const imagePng = hasImage ? ports.readImage(plat, "png", targets) : null;
        const imageBmp = hasImage ? ports.readImage(plat, "bmp", targets) : null;
        if (!imagePng && !imageBmp) {
            const fallback = linuxFileFallback(plat, targets);
            if (fallback.targets.length > 0) return { timestamp: now, marker: null, ...fallback };
            if (text) {
                const fallback = fileFallback(ports.parseImagePathText(ports.decodeText(text, "utf-8")));
                if (fallback.targets.length > 0) return { timestamp: now, marker: null, ...fallback };
            }
        }
        const filteredTargets = targets.filter(t => {
            if (isSupportedImageTarget(t)) return imagePng !== null || imageBmp !== null;
            if (t.includes("text/plain") || t === "STRING" || t === "UTF8_STRING") return text !== null;
            return true;
        });
        return { timestamp: now, marker: null, targets: filteredTargets, text, imagePng, imageBmp };
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
