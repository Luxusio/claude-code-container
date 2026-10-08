import { describe, expect, it } from "vitest";
import { buildImageFileClipboardFallbackFromPaths, createClipboardSnapshotReader, createClipboardSnapshotState, invalidateClipboardCache } from "../../application/clipboard/snapshot.js";
import type { CapturedClipboardSnapshot } from "../../domain/clipboard/snapshot.js";
import type { ClipboardSnapshotPorts } from "../../ports/clipboard/snapshot.js";

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture() {
    const calls: string[] = []; const sentinel = new Error("native read sentinel");
    let now = 10; let marker: string | null = "m";
    let capture: CapturedClipboardSnapshot<Buffer> = { targets: ["image/png"], text: null, imagePng: Buffer.from("image"), imageBmp: null, marker: "m" };
    const ports: ClipboardSnapshotPorts<Buffer> = {
        now: () => now, readChangeMarker: async p => { calls.push(`marker:${p}`); return marker; },
        readWindowsCapture: async () => { calls.push("windows"); return capture; },
        readDarwinFrame: async () => { calls.push("darwin"); return "frame"; },
        parseDarwinCapture: () => capture,
        readDarwinLegacyImage: async () => { calls.push("legacy-image"); return { status: 0, stdout: Buffer.alloc(0) }; },
        readDarwinLegacyText: async () => { calls.push("legacy-text"); return { status: 0, stdout: Buffer.alloc(0) }; },
        readDarwinPngpaste: () => { calls.push("pngpaste"); return { status: 1, stdout: Buffer.alloc(0) }; },
        parseAppleScriptImage: () => null,
        readDarwinFileReferenceData: () => { calls.push("darwin-files"); return { status: 1, stdout: Buffer.alloc(0) }; },
        readLinuxUriData: (_p, t) => { calls.push(`uri:${t}`); return { status: 1, stdout: Buffer.alloc(0) }; },
        decodeText: (b, encoding) => b.toString(encoding), parseFileUriList: text => text.split("\n"), parseImagePathText: () => [],
        readTargets: p => { calls.push(`targets:${p}`); return []; }, readText: p => { calls.push(`text:${p}`); return null; },
        readImage: (p, f) => { calls.push(`${f}:${p}`); return null; },
        readImageFile: p => { calls.push(`read:${p}`); return null; }, copyImageFile: p => { calls.push(`copy:${p}`); return null; },
        createReadError: () => sentinel,
    };
    const state = createClipboardSnapshotState<Buffer>();
    return { calls, ports, state, sentinel, read: createClipboardSnapshotReader(ports, state),
        setNow: (value: number) => { now = value; }, setMarker: (value: string | null) => { marker = value; },
        setCapture: (value: CapturedClipboardSnapshot<Buffer>) => { capture = value; } };
}

describe("Clipboard snapshot application policy", () => {
    it("keeps the returned then promise distinct from the stored catch recovery promise", async () => {
        const f = fixture(); const next = deferred<void>(); const gate = deferred<unknown>();
        let returned: Promise<unknown> | undefined;
        const queue = gate.promise;
        const nativeThen = queue.then.bind(queue);
        queue.then = ((...args: Parameters<typeof queue.then>) => { returned = nativeThen(...args); return returned; }) as typeof queue.then;
        f.state.readQueue = queue;
        const result = f.read("windows");
        expect(f.read.name).toBe("getCachedClipboardSnapshot"); expect(f.read.length).toBe(1);
        expect(f.read.constructor.name).toBe("Function"); expect(result).toBe(returned); expect(f.state.readQueue).not.toBe(result);
        f.ports.readWindowsCapture = async () => { await next.promise; return { targets: [], text: null, imagePng: null, imageBmp: null, marker: "m" }; };
        gate.resolve(undefined); next.resolve(); await result; await f.state.readQueue;
    });
    it("serializes different platform reads on the one supplied state", async () => {
        const f = fixture(); const gate = deferred<CapturedClipboardSnapshot<Buffer>>();
        f.ports.readWindowsCapture = () => { f.calls.push("pending-windows"); return gate.promise; };
        const first = f.read("windows"); const second = f.read("linux-wayland", true);
        await Promise.resolve(); await Promise.resolve();
        expect(f.calls).toEqual(["marker:windows", "pending-windows"]);
        gate.resolve({ targets: [], text: null, imagePng: null, imageBmp: null, marker: "m" });
        await first; await second;
        expect(f.calls.indexOf("targets:linux-wayland")).toBeGreaterThan(f.calls.indexOf("pending-windows"));
    });
    it("repeats a stale successful read but propagates a stale failed read, then recovers the queue", async () => {
        const f = fixture(); const gate = deferred<CapturedClipboardSnapshot<Buffer>>(); let count = 0;
        const image = Buffer.from("new");
        f.ports.readWindowsCapture = async () => ++count === 1 ? gate.promise : { marker: "m", targets: ["image/png"], text: null, imagePng: image, imageBmp: null };
        const read = f.read("windows"); await Promise.resolve(); await Promise.resolve(); invalidateClipboardCache(f.state);
        gate.resolve({ marker: "m", targets: [], text: null, imagePng: null, imageBmp: null });
        expect((await read).imagePng).toBe(image); expect(count).toBe(2);
        const failing = deferred<CapturedClipboardSnapshot<Buffer>>(); f.ports.readWindowsCapture = () => failing.promise;
        const failure = { original: "raw" }; const rejected = f.read("windows", true); const observed = rejected.catch(e => e);
        await Promise.resolve(); await Promise.resolve(); invalidateClipboardCache(f.state); failing.reject(failure);
        expect(await observed).toBe(failure); expect(f.state.cache).toBeNull();
        f.ports.readWindowsCapture = async () => ({ marker: "m", targets: [], text: null, imagePng: null, imageBmp: null });
        await expect(f.read("windows", true)).resolves.toMatchObject({ marker: "m" });
    });
    it("uses marker cache for positive data, caps negative marker cache at 200ms, and honors force", async () => {
        const f = fixture(); const positive = await f.read("windows"); f.setNow(1000);
        expect(await f.read("windows")).toBe(positive); expect(f.calls.filter(c => c === "windows")).toHaveLength(1);
        expect(await f.read("windows", true)).not.toBe(positive); expect(f.calls.filter(c => c === "windows")).toHaveLength(2);
        f.setCapture({ marker: "m", targets: [], text: null, imagePng: null, imageBmp: null }); f.setNow(2000);
        const negative = await f.read("windows", true); f.setNow(2199); expect(await f.read("windows")).toBe(negative);
        f.setNow(2200); expect(await f.read("windows")).not.toBe(negative);
        f.setMarker("changed"); f.setCapture({ marker: "changed", targets: [], text: null, imagePng: null, imageBmp: null });
        expect((await f.read("windows")).marker).toBe("changed");
    });
    it("uses time only when the change marker is unavailable", async () => {
        const f = fixture(); f.setMarker(null); f.setCapture({ marker: null, targets: [], text: null, imagePng: null, imageBmp: null });
        f.ports.readTargets = () => [];
        const cached = await f.read("linux-x11"); f.setNow(209); expect(await f.read("linux-x11")).toBe(cached);
        f.setNow(210); expect(await f.read("linux-x11")).not.toBe(cached);
    });
    it.each(["windows", "wsl", "darwin"] as const)("requires captured marker coherence on %s and stops after three observations", async platform => {
        const f = fixture(); f.setCapture({ marker: "wrong", targets: [], text: null, imagePng: null, imageBmp: null });
        await expect(f.read(platform)).rejects.toBe(f.sentinel); expect(f.state.cache).toBeNull();
        expect(f.calls.filter(c => c === (platform === "darwin" ? "darwin" : "windows"))).toHaveLength(3);
        expect(f.calls.filter(c => c === `marker:${platform}`)).toHaveLength(4);
    });
    it.each(["windows", "wsl", "darwin"] as const)("rejects a missing captured marker on %s when an observed marker exists", async platform => {
        const f = fixture(); f.setCapture({ targets: [], text: null, imagePng: null, imageBmp: null });
        await expect(f.read(platform)).rejects.toBe(f.sentinel);
    });
    it("accepts the Darwin legacy missing marker only when both marker observations are null", async () => {
        const f = fixture(); f.setMarker(null); f.ports.readDarwinFrame = async () => null;
        const text = Buffer.from("plain"); f.ports.readDarwinLegacyText = async () => ({ status: 0, stdout: text });
        expect(await f.read("darwin")).toMatchObject({ marker: null, text });
    });
    it("returns native Darwin image without converter, file, decode or text probes", async () => {
        const f = fixture(); const result = await f.read("darwin");
        expect(result.imagePng).not.toBeNull(); expect(f.calls).toEqual(["marker:darwin", "darwin", "marker:darwin"]);
    });
    it("rejects an invalid Darwin native capture with the supplied native error identity and recovers", async () => {
        const f = fixture(); const parse = f.ports.parseDarwinCapture; f.ports.parseDarwinCapture = () => null;
        await expect(f.read("darwin")).rejects.toBe(f.sentinel); expect(f.state.cache).toBeNull();
        f.ports.parseDarwinCapture = parse; await expect(f.read("darwin")).resolves.toMatchObject({ marker: "m" });
    });
    it("accepts the first coherent snapshot after unstable captures and keeps its original bytes", async () => {
        const f = fixture(); let count = 0; const bytes = Buffer.from("coherent");
        f.ports.readWindowsCapture = async () => ({ marker: ++count === 3 ? "m" : "old", targets: ["image/png"], text: null, imagePng: bytes, imageBmp: null });
        const snapshot = await f.read("windows"); expect(count).toBe(3); expect(snapshot.imagePng).toBe(bytes); expect(f.state.cache).toBe(snapshot);
    });
    it("converts Darwin frames before file fallback and keeps opaque data and native marker", async () => {
        const f = fixture(); const text = Buffer.from("text"); const png = Buffer.from("png");
        f.setCapture({ marker: "m", targets: ["text/plain", "image/png"], text, imagePng: null, imageBmp: null });
        f.ports.readDarwinPngpaste = () => ({ status: 0, stdout: png });
        const result = await f.read("darwin"); expect(result.imagePng).toBe(png); expect(result.text).toBe(text);
        expect(result.targets).toEqual(["text/plain", "image/png"]); expect(result.marker).toBe("m"); expect(f.calls).not.toContain("darwin-files");
    });
    it("tries Darwin file references before text paths, and preserves captured marker", async () => {
        const f = fixture(); const text = Buffer.from("text path"); const copied = Buffer.from("copied path");
        f.setCapture({ marker: "m", targets: ["text/plain"], text, imagePng: null, imageBmp: null });
        f.ports.readDarwinFileReferenceData = () => ({ status: 0, stdout: Buffer.from(" /one\r\n /two \n") });
        f.ports.copyImageFile = path => { f.calls.push(`copy:${path}`); return path === "/two" ? copied : null; };
        f.ports.parseImagePathText = () => { throw new Error("Text fallback must not run"); };
        const result = await f.read("darwin"); expect(result.text).toBe(copied); expect(result.marker).toBe("m");
        expect(f.calls.filter(c => /^(?:read|copy):/.test(c))).toEqual(["read:/one", "read:/two", "copy:/one", "copy:/two"]);
    });
    it("falls from empty Darwin file references to image paths in native text, then keeps ordinary text unchanged", async () => {
        const f = fixture(); const text = Buffer.from("/image.png"); const png = Buffer.from("fallback-image");
        f.setCapture({ marker: "m", targets: ["text/plain"], text, imagePng: null, imageBmp: null });
        f.ports.parseImagePathText = value => { f.calls.push(`text-path:${value}`); return [value]; };
        f.ports.readImageFile = path => { f.calls.push(`read:${path}`); return png; };
        const result = await f.read("darwin"); expect(result.imagePng).toBe(png); expect(result.text).toBeNull(); expect(result.marker).toBe("m");
        expect(f.calls.indexOf("darwin-files")).toBeLessThan(f.calls.indexOf("text-path:/image.png"));
        f.ports.parseImagePathText = () => []; expect((await f.read("darwin", true)).text).toBe(text);
    });
    it("legacy Darwin parses image first, converts second, and avoids file/text probes after finding an image", async () => {
        const f = fixture(); f.setMarker(null); f.ports.readDarwinFrame = async () => null;
        const appleBytes = Buffer.from("AppleScript wire"); const png = Buffer.from("png"); const text = Buffer.from("plain");
        f.ports.readDarwinLegacyImage = async () => ({ status: 0, stdout: appleBytes });
        f.ports.readDarwinLegacyText = async () => ({ status: 0, stdout: text });
        f.ports.parseAppleScriptImage = bytes => { expect(bytes).toBe(appleBytes); f.calls.push("parse-image"); return png; };
        const parsed = await f.read("darwin"); expect(parsed.imagePng).toBe(png); expect(parsed.text).toBe(text);
        expect(parsed.targets).toEqual(["image/png", "text/plain"]); expect(f.calls).not.toContain("pngpaste"); expect(f.calls).not.toContain("darwin-files");
        f.calls.length = 0; f.ports.parseAppleScriptImage = () => null;
        f.ports.readDarwinPngpaste = () => { f.calls.push("pngpaste"); return { status: 0, stdout: png }; };
        expect((await f.read("darwin", true)).imagePng).toBe(png); expect(f.calls).toContain("pngpaste"); expect(f.calls).not.toContain("darwin-files");
    });
    it.each(["image", "text"])("fails Darwin legacy parallel %s reads without publishing a negative cache", async failed => {
        const f = fixture(); f.ports.readDarwinFrame = async () => null;
        f.ports.readDarwinLegacyImage = async () => { f.calls.push("legacy-image"); return { status: failed === "image" ? 1 : 0, stdout: Buffer.alloc(0) }; };
        f.ports.readDarwinLegacyText = async () => { f.calls.push("legacy-text"); return { status: failed === "text" ? 1 : 0, stdout: Buffer.alloc(0) }; };
        await expect(f.read("darwin")).rejects.toBe(f.sentinel);
        expect(f.calls.slice(1, 3)).toEqual(["legacy-image", "legacy-text"]); expect(f.state.cache).toBeNull();
    });
    it("filters Linux advertised text/images using actual bytes and preserves image precedence", async () => {
        const f = fixture(); const bmp = Buffer.from("bmp"); f.setMarker(null);
        f.ports.readTargets = p => { f.calls.push(`targets:${p}`); return ["image/jpeg", "UTF8_STRING", "custom", "image/bmp"]; };
        f.ports.readImage = (p, format) => { f.calls.push(`${format}:${p}`); return format === "bmp" ? bmp : null; };
        const result = await f.read("linux-x11");
        expect(result.targets).toEqual(["image/jpeg", "custom", "image/bmp"]); expect(result.imageBmp).toBe(bmp);
        expect(f.calls).toEqual(["marker:linux-x11", "targets:linux-x11", "text:linux-x11", "png:linux-x11", "bmp:linux-x11"]);
    });
    it("deduplicates advertised Linux URI targets and chooses file references before text paths", async () => {
        const f = fixture(); f.setMarker(null); const image = Buffer.from("file image");
        f.ports.readTargets = () => ["x-special/gnome-copied-files", "text/uri-list", "x-special/gnome-copied-files", "UTF8_STRING"];
        f.ports.readText = () => Buffer.from("text-path");
        f.ports.readLinuxUriData = (_p, target) => { f.calls.push(`uri:${target}`); return { status: 0, stdout: target === "text/uri-list" ? Buffer.from("/file") : Buffer.alloc(0) }; };
        f.ports.readImageFile = path => { f.calls.push(`read:${path}`); return image; };
        f.ports.parseImagePathText = () => { throw new Error("No text fallback"); };
        const result = await f.read("linux-wayland"); expect(result.imagePng).toBe(image);
        expect(f.calls.filter(c => c.startsWith("uri:"))).toEqual(["uri:x-special/gnome-copied-files", "uri:text/uri-list"]);
    });
    it("tries both failed/empty Linux URI facts before local-image-path text and excludes absent image advertisements", async () => {
        const f = fixture(); f.setMarker(null); const text = Buffer.from("/text.png"); const image = Buffer.from("text-image");
        f.ports.readTargets = () => ["image/png", "UTF8_STRING", "other"]; f.ports.readText = () => text;
        f.ports.readLinuxUriData = (_p, target) => { f.calls.push(`uri:${target}`); return { status: target === "text/uri-list" ? 1 : 0, stdout: Buffer.alloc(0) }; };
        f.ports.parseImagePathText = value => { f.calls.push(`text-path:${value}`); return [value]; };
        f.ports.readImageFile = () => image;
        expect((await f.read("linux-x11")).imagePng).toBe(image);
        expect(f.calls.filter(c => /^(?:uri|text-path):/.test(c))).toEqual(["uri:text/uri-list", "uri:x-special/gnome-copied-files", "text-path:/text.png"]);
        f.ports.parseImagePathText = () => []; expect((await f.read("linux-x11", true)).targets).toEqual(["UTF8_STRING", "other"]);
    });
    it("keeps file callbacks bare, tries every read before any copy, and accepts truthy empty bytes", () => {
        const calls: string[] = []; const empty = Buffer.alloc(0); const copied = Buffer.from("path");
        function read(this: unknown, path: string) { expect(this).toBeUndefined(); calls.push(`read:${path}`); return null; }
        function copy(this: unknown, path: string) { expect(this).toBeUndefined(); calls.push(`copy:${path}`); return path === "b" ? copied : null; }
        expect(buildImageFileClipboardFallbackFromPaths(["a", "b"], read, copy).text).toBe(copied);
        expect(calls).toEqual(["read:a", "read:b", "copy:a", "copy:b"]);
        expect(buildImageFileClipboardFallbackFromPaths(["a"], () => empty, () => { throw new Error("No copy"); }).imagePng).toBe(empty);
        const failure = { raw: true };
        let observed: unknown;
        try { buildImageFileClipboardFallbackFromPaths(["a"], () => { throw failure; }, copy); } catch (error) { observed = error; }
        expect(observed).toBe(failure);
    });
});
