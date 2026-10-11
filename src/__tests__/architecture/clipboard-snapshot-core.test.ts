import { describe, expect, it } from "vitest";
import { buildImageFileClipboardFallbackFromPaths, createClipboardSnapshotReader, createClipboardSnapshotState, invalidateClipboardCache } from "../../application/clipboard/snapshot.js";
import type { CapturedClipboardSnapshot } from "../../domain/clipboard/snapshot.js";
import type { ClipboardSnapshotPorts } from "../../ports/clipboard/snapshot.js";

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function captured(snapshot: CapturedClipboardSnapshot<Buffer>, fileReferences: string[] = [], textImagePaths: string[] = []): import("../../ports/clipboard/snapshot.js").ClipboardCaptureObservation<Buffer> {
    return { kind: "captured", snapshot, fileReferences, textImagePaths };
}
function fixture() {
    const calls: string[] = []; const sentinel = new Error("native read sentinel");
    let now = 10; let marker: string | null = "m";
    let capture: CapturedClipboardSnapshot<Buffer> = { targets: ["image/png"], text: null, imagePng: Buffer.from("image"), imageBmp: null, marker: "m" };
    const ports: ClipboardSnapshotPorts<Buffer> = {
        now: () => now,
        readChangeMarker: async p => { calls.push(`marker:${p}`); return { kind: "observed", marker }; },
        capture: async p => { calls.push(`capture:${p}`); return { kind: "captured", snapshot: capture, fileReferences: [], textImagePaths: [] }; },
        readImageFile: p => { calls.push(`read:${p}`); return null; },
        copyImageFile: p => { calls.push(`copy:${p}`); return null; },
        createReadError: () => sentinel,
    };
    const state = createClipboardSnapshotState<Buffer>();
    return { calls, ports, state, sentinel, read: createClipboardSnapshotReader(ports, state),
        setNow: (value: number) => { now = value; }, setMarker: (value: string | null) => { marker = value; },
        setCapture: (value: CapturedClipboardSnapshot<Buffer>) => { capture = value; } };
}

describe("Clipboard snapshot application policy", () => {
    it("serializes different platform reads on the one supplied state", async () => {
        const f = fixture(); const gate = deferred<import("../../ports/clipboard/snapshot.js").ClipboardCaptureObservation<Buffer>>();
        const started = deferred<void>();
        f.ports.capture = p => { f.calls.push(`capture:${p}`); started.resolve(); return gate.promise; };
        const first = f.read("windows"); const second = f.read("linux-wayland", true);
        await started.promise;
        expect(f.calls).toEqual(["marker:windows", "capture:windows"]);
        gate.resolve({ kind: "captured", snapshot: { targets: [], text: null, imagePng: null, imageBmp: null, marker: "m" }, fileReferences: [], textImagePaths: [] });
        await first; await second;
        expect(f.calls.indexOf("capture:linux-wayland")).toBeGreaterThan(f.calls.indexOf("capture:windows"));
    });
    it("repeats a stale successful read but propagates a stale failed read, then recovers the queue", async () => {
        const f = fixture(); const gate = deferred<import("../../ports/clipboard/snapshot.js").ClipboardCaptureObservation<Buffer>>(); let count = 0;
        const image = Buffer.from("new");
        const started = deferred<void>();
        f.ports.capture = async () => { started.resolve(); return ++count === 1 ? gate.promise : captured({ marker: "m", targets: ["image/png"], text: null, imagePng: image, imageBmp: null }); };
        const read = f.read("windows"); await started.promise; invalidateClipboardCache(f.state);
        gate.resolve(captured({ marker: "m", targets: [], text: null, imagePng: null, imageBmp: null }));
        expect((await read).imagePng).toBe(image); expect(count).toBe(2);
        const failing = deferred<import("../../ports/clipboard/snapshot.js").ClipboardCaptureObservation<Buffer>>(); const failureStarted = deferred<void>();
        f.ports.capture = () => { failureStarted.resolve(); return failing.promise; };
        const failure = { original: "raw" }; const rejected = f.read("windows", true); const observed = rejected.catch(e => e);
        await failureStarted.promise; invalidateClipboardCache(f.state); failing.reject(failure);
        expect(await observed).toBe(failure); expect(f.state.cache).toBeNull();
        f.ports.capture = async () => captured({ marker: "m", targets: [], text: null, imagePng: null, imageBmp: null });
        await expect(f.read("windows", true)).resolves.toMatchObject({ marker: "m" });
    });
    it("uses marker cache for positive data, caps negative marker cache at 200ms, and honors force", async () => {
        const f = fixture(); const positive = await f.read("windows"); f.setNow(1000);
        expect(await f.read("windows")).toBe(positive); expect(f.calls.filter(c => c === "capture:windows")).toHaveLength(1);
        expect(await f.read("windows", true)).not.toBe(positive); expect(f.calls.filter(c => c === "capture:windows")).toHaveLength(2);
        f.setCapture({ marker: "m", targets: [], text: null, imagePng: null, imageBmp: null }); f.setNow(2000);
        const negative = await f.read("windows", true); f.setNow(2199); expect(await f.read("windows")).toBe(negative);
        f.setNow(2200); expect(await f.read("windows")).not.toBe(negative);
        f.setMarker("changed"); f.setCapture({ marker: "changed", targets: [], text: null, imagePng: null, imageBmp: null });
        expect((await f.read("windows")).marker).toBe("changed");
    });
    it("uses the 200ms TTL when no marker is observed", async () => {
        const f = fixture(); f.setMarker(null); f.setCapture({ marker: null, targets: [], text: null, imagePng: null, imageBmp: null });
        const cached = await f.read("linux-x11"); f.setNow(209); expect(await f.read("linux-x11")).toBe(cached);
        f.setNow(210); expect(await f.read("linux-x11")).not.toBe(cached);
    });
    it.each(["windows", "wsl", "darwin"] as const)("requires captured marker coherence on %s and stops after three observations", async platform => {
        const f = fixture(); f.setCapture({ marker: "wrong", targets: [], text: null, imagePng: null, imageBmp: null });
        await expect(f.read(platform)).rejects.toBe(f.sentinel); expect(f.state.cache).toBeNull();
        expect(f.calls.filter(c => c === `capture:${platform}`)).toHaveLength(3);
        expect(f.calls.filter(c => c === `marker:${platform}`)).toHaveLength(4);
    });
    it.each(["windows", "wsl", "darwin"] as const)("rejects a missing captured marker on %s when an observed marker exists", async platform => {
        const f = fixture(); f.setCapture({ targets: [], text: null, imagePng: null, imageBmp: null });
        await expect(f.read(platform)).rejects.toBe(f.sentinel);
    });
    it("accepts a missing Darwin marker only when both surrounding observations are null", async () => {
        const f = fixture(); f.setMarker(null);
        const text = Buffer.from("ordinary"); f.setCapture({ targets: ["text/plain"], text, imagePng: null, imageBmp: null });
        expect(await f.read("darwin")).toMatchObject({ marker: null, text });
        let markerReads = 0;
        f.ports.readChangeMarker = async () => ({ kind: "observed", marker: ++markerReads === 1 ? null : "changed" });
        await expect(f.read("darwin", true)).rejects.toBe(f.sentinel);
    });
    it("accepts the first coherent snapshot and timestamps its completion", async () => {
        const f = fixture(); let count = 0; const bytes = Buffer.from("coherent");
        f.ports.capture = async () => { f.setNow(50); return captured({ marker: ++count === 3 ? "m" : "old", targets: ["image/png"], text: null, imagePng: bytes, imageBmp: null }); };
        const result = await f.read("windows"); expect(count).toBe(3); expect(result.imagePng).toBe(bytes); expect(result.timestamp).toBe(50);
    });
    it.each(["marker", "capture"] as const)("fails unavailable %s without negative caching and recovers", async leaf => {
        const f = fixture(); const original = f.ports[leaf === "marker" ? "readChangeMarker" : "capture"];
        if (leaf === "marker") f.ports.readChangeMarker = async () => ({ kind: "unavailable" });
        else f.ports.capture = async () => ({ kind: "unavailable" });
        await expect(f.read("windows")).rejects.toBe(f.sentinel); expect(f.state.cache).toBeNull();
        if (leaf === "marker") f.ports.readChangeMarker = original as typeof f.ports.readChangeMarker;
        else f.ports.capture = original as typeof f.ports.capture;
        await expect(f.read("windows")).resolves.toMatchObject({ marker: "m" });
    });
    it("leaves a prior cache intact on unexpected native failures", async () => {
        const f = fixture(); const cached = await f.read("windows"); const failure = new Error("unexpected native failure");
        f.ports.capture = async () => { throw failure; };
        await expect(f.read("windows", true)).rejects.toBe(failure); expect(f.state.cache).toBe(cached);
        f.ports.readChangeMarker = async () => { throw failure; };
        await expect(f.read("windows")).rejects.toBe(failure); expect(f.state.cache).toBe(cached);
    });
    it.each(["windows", "wsl"] as const)("rejects markerless %s captures even with both observations null", async platform => {
        const f = fixture(); f.setMarker(null); f.setCapture({ targets: [], text: null, imagePng: null, imageBmp: null });
        await expect(f.read(platform)).rejects.toBe(f.sentinel); expect(f.state.cache).toBeNull();
    });
    it("uses the initial timestamp for Linux and honors fresh reads", async () => {
        const f = fixture(); f.setMarker(null); f.setCapture({ targets: [], text: null, imagePng: null, imageBmp: null });
        const original = f.ports.capture;
        f.ports.capture = async p => { f.setNow(100); return original(p); };
        const first = await f.read("linux-wayland"); expect(first.timestamp).toBe(10);
        expect(await f.read("linux-wayland", true)).not.toBe(first);
    });
    it.each(["imagePng", "imageBmp"] as const)("keeps direct %s bytes ahead of all file groups", async format => {
        const f = fixture(); const bytes = Buffer.from("native");
        f.ports.capture = async () => captured({ marker: "m", targets: ["image/png"], text: null, imagePng: null, imageBmp: null, [format]: bytes }, ["reference"], ["text"]);
        expect((await f.read("darwin"))[format]).toBe(bytes);
        expect(f.calls).toEqual(["marker:darwin", "marker:darwin"]);
    });
    it("resolves each group before observing the final marker, with reference copies before text reads", async () => {
        const f = fixture(); const copied = Buffer.from("/run/ccc/clipboard-files/image");
        f.ports.capture = async () => captured({ marker: "m", targets: [], text: null, imagePng: null, imageBmp: null }, ["a", "b"], ["text"]);
        f.ports.copyImageFile = p => { f.calls.push(`copy:${p}`); return p === "b" ? copied : null; };
        const result = await f.read("darwin"); expect(result.text).toBe(copied); expect(result.marker).toBe("m");
        expect(f.calls).toEqual(["marker:darwin", "read:a", "read:b", "copy:a", "copy:b", "marker:darwin"]);
    });
    it("tries the text group after all reference failures and preserves ordinary text when both fail", async () => {
        const f = fixture(); const text = Buffer.from("ordinary"); const image = Buffer.from("file");
        f.ports.capture = async () => captured({ marker: "m", targets: ["text/plain"], text, imagePng: null, imageBmp: null }, ["reference"], ["one", "two"]);
        f.ports.readImageFile = p => { f.calls.push(`read:${p}`); return p === "two" ? image : null; };
        const result = await f.read("darwin"); expect(result.imagePng).toBe(image); expect(result.text).toBeNull();
        expect(f.calls).toEqual(["marker:darwin", "read:reference", "copy:reference", "read:one", "read:two", "marker:darwin"]);
        f.ports.readImageFile = () => null; expect((await f.read("darwin", true)).text).toBe(text);
    });
    it("discards file fallback bytes when the marker changes and resolves the next attempt", async () => {
        const f = fixture(); let attempt = 0; const stale = Buffer.from("stale"); const fresh = Buffer.from("fresh");
        f.ports.capture = async () => captured({ marker: ++attempt === 1 ? "old" : "m", targets: [], text: null, imagePng: null, imageBmp: null }, [String(attempt)]);
        f.ports.readImageFile = p => p === "1" ? stale : fresh;
        expect((await f.read("darwin")).imagePng).toBe(fresh); expect(attempt).toBe(2);
    });
    it("tries every candidate read before copying and propagates actual file failures", () => {
        const calls: string[] = []; const copied = Buffer.from("path");
        const result = buildImageFileClipboardFallbackFromPaths(["a", "b"], p => { calls.push(`read:${p}`); return null; }, p => { calls.push(`copy:${p}`); return p === "b" ? copied : null; });
        expect(result.text).toBe(copied); expect(calls).toEqual(["read:a", "read:b", "copy:a", "copy:b"]);
        const failure = new Error("file read");
        expect(() => buildImageFileClipboardFallbackFromPaths(["a"], () => { throw failure; }, () => null)).toThrow(failure);
    });
});
