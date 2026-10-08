import { describe, expect, it } from "vitest";
import { createClipboardTextWriter } from "../../application/clipboard/text-write.js";
import { createClipboardSnapshotReader, createClipboardSnapshotState } from "../../application/clipboard/snapshot.js";
import type { ClipboardTextWritePorts } from "../../ports/clipboard/text-write.js";
import type { ClipboardSnapshotPorts } from "../../ports/clipboard/snapshot.js";

function fixture() {
    const calls: unknown[] = []; const prepared: { input: Buffer } = { input: Buffer.alloc(0) }; const child = { opaque: "writer" }; const timer = { opaque: "timer" };
    const state = createClipboardSnapshotState<Buffer>(); state.cache = { timestamp: 0, targets: [], text: null, imagePng: null, imageBmp: null };
    let timeout!: () => void; let error!: () => void; let exit!: (code: number | null) => void; let inputError!: () => void;
    const ports: ClipboardTextWritePorts<Buffer, typeof prepared, typeof child, typeof timer> = {
        encodeText: text => { calls.push("encode"); return Buffer.from(text); }, decodeText: bytes => { calls.push("decode"); return bytes.toString(); },
        prepareWriter: (bytes, platform) => { calls.push(["prepare", bytes, platform, state.generation]); prepared.input = bytes; return prepared; },
        launchWriter: (value, platform) => { calls.push(["launch", value, platform, state.generation, state.cache]); return child; },
        scheduleTimeout: (callback, ms) => { calls.push(["schedule", ms]); timeout = callback; return timer; },
        cancelReadTimer: value => { calls.push(["clear", value]); return undefined; },
        onWriterError: (value, callback) => { calls.push(["on-error", value]); error = callback; return undefined; },
        onWriterExit: (value, callback) => { calls.push(["on-exit", value]); exit = callback; return undefined; },
        onInputError: (value, callback) => { calls.push(["on-input-error", value]); inputError = callback; return undefined; },
        endInput: (value, data) => { calls.push(["end", value, data]); return undefined; },
        killWriter: value => { calls.push(["kill", value]); return undefined; },
    };
    return { calls, ports, state, prepared, child, timer, write: createClipboardTextWriter(ports, state),
        timeout: () => timeout(), error: () => error(), exit: (code: number | null) => exit(code), inputError: () => inputError() };
}

describe("Clipboard text-write application transaction", () => {
    it("validates before preparing, invalidates before launch and registers bounded callbacks in order", async () => {
        const f = fixture(); const text = "\uFEFF한글 😀\r\n"; const result = f.write(text, "darwin");
        expect(f.write.name).toBe("writeClipboardText"); expect(f.write.length).toBe(2); expect(f.write.constructor.name).toBe("AsyncFunction");
        expect(f.calls).toEqual(["encode", "decode", ["prepare", Buffer.from(text), "darwin", 0],
            ["launch", f.prepared, "darwin", 1, null], ["schedule", 5000], ["on-error", f.child], ["on-exit", f.child], ["on-input-error", f.child], ["end", f.child, f.prepared]]);
        expect(f.state.generation).toBe(1); f.exit(0); await expect(result).resolves.toBeUndefined();
        expect(f.calls.at(-1)).toEqual(["clear", f.timer]); expect(f.state.generation).toBe(2); expect(f.state.cache).toBeNull();
    });
    it.each(["nul", "oversize", "lossy"])("rejects %s text before preparation or invalidation", async reason => {
        const f = fixture(); const cached = f.state.cache;
        if (reason === "lossy") f.ports.decodeText = () => "replacement";
        const text = reason === "nul" ? "a\0b" : reason === "oversize" ? "x".repeat(1048577) : "valid";
        await expect(f.write(text, "linux-x11")).rejects.toThrow("Invalid clipboard text");
        expect(f.calls.some(call => Array.isArray(call))).toBe(false); expect(f.state.generation).toBe(0); expect(f.state.cache).toBe(cached);
    });
    it.each(["", "x".repeat(1048576)])("accepts empty and exactly bounded UTF8 text", async text => {
        const f = fixture(); const result = f.write(text, "linux-x11"); f.exit(0); await result;
        expect(f.prepared.input.length).toBe(Buffer.byteLength(text)); expect(f.state.generation).toBe(2);
    });
    it("keeps writer absence before invalidation and preserves raw synchronous launch rejection with final invalidation", async () => {
        const absent = fixture(); const failure = { raw: "unavailable writer" }; const cached = absent.state.cache;
        absent.ports.prepareWriter = () => { throw failure; };
        await expect(absent.write("ok", "unsupported")).rejects.toBe(failure); expect(absent.state.generation).toBe(0); expect(absent.state.cache).toBe(cached);
        const failed = fixture(); failed.ports.launchWriter = () => { throw failure; };
        await expect(failed.write("ok", "windows")).rejects.toBe(failure); expect(failed.state.generation).toBe(2); expect(failed.state.cache).toBeNull();
    });
    it.each(["writer-error", "exit-one", "exit-null", "input-error", "timeout"])("settles %s once and kills only input failure or timeout", async event => {
        const f = fixture(); const result = f.write("text", "linux-wayland"); const caught = result.catch(e => e);
        if (event === "writer-error") f.error(); else if (event === "exit-one") f.exit(1); else if (event === "exit-null") f.exit(null);
        else if (event === "input-error") f.inputError(); else f.timeout();
        expect((await caught).message).toBe("Clipboard write failed");
        const cleared = f.calls.filter(call => Array.isArray(call) && call[0] === "clear"); expect(cleared).toHaveLength(1);
        expect(f.calls.filter(call => Array.isArray(call) && call[0] === "kill")).toHaveLength(event === "input-error" || event === "timeout" ? 1 : 0);
        f.exit(0); f.error(); expect(f.calls.filter(call => Array.isArray(call) && call[0] === "clear")).toHaveLength(1);
        expect(f.state.generation).toBe(2);
    });
    it("lets input kill errors escape the callback without settling, then accepts later writer exit", async () => {
        const f = fixture(); const failure = new Error("kill failed"); f.ports.killWriter = () => { throw failure; };
        const result = f.write("text", "linux-x11"); expect(() => f.inputError()).toThrow(failure);
        expect(f.state.generation).toBe(1); expect(f.calls.filter(call => Array.isArray(call) && call[0] === "clear")).toHaveLength(0);
        f.exit(0); await result; expect(f.state.generation).toBe(2);
    });
    it("keeps a clear-timeout throw outside settlement and ignores subsequent exit callbacks", async () => {
        const f = fixture(); const failure = new Error("clear failed"); f.ports.cancelReadTimer = () => { throw failure; };
        const result = f.write("text", "linux-x11"); let settled = false; void result.then(() => { settled = true; }, () => { settled = true; });
        expect(() => f.exit(0)).toThrow(failure); f.exit(1); f.error(); await Promise.resolve();
        expect(settled).toBe(false); expect(f.state.generation).toBe(1);
        // No native handle is created by this fixture; the unresolved Promise pins the existing callback contract.
    });
    it("invalidates the exact shared read state so an in-flight snapshot cannot publish pre-write bytes", async () => {
        const f = fixture(); let resolve!: (value: { targets: string[]; text: Buffer; imagePng: null; imageBmp: null; marker: string }) => void;
        const gate = new Promise<{ targets: string[]; text: Buffer; imagePng: null; imageBmp: null; marker: string }>(yes => { resolve = yes; });
        let captures = 0; const latest = Buffer.from("new");
        const forbidden = () => { throw new Error("Unexpected snapshot effect"); };
        const ports: ClipboardSnapshotPorts<Buffer> = { now: () => 1, readChangeMarker: async () => "m",
            readWindowsCapture: () => ++captures === 1 ? gate : Promise.resolve({ targets: ["text/plain"], text: latest, imagePng: null, imageBmp: null, marker: "m" }),
            readDarwinFrame: forbidden, parseDarwinCapture: forbidden, readDarwinLegacyImage: forbidden, readDarwinLegacyText: forbidden,
            readDarwinPngpaste: forbidden, parseAppleScriptImage: forbidden, readDarwinFileReferenceData: forbidden,
            readLinuxUriData: forbidden, decodeText: forbidden, parseFileUriList: forbidden, parseImagePathText: forbidden,
            readTargets: forbidden, readText: forbidden, readImage: forbidden, readImageFile: forbidden, copyImageFile: forbidden, createReadError: forbidden };
        const read = createClipboardSnapshotReader(ports, f.state)("windows", true); await Promise.resolve(); await Promise.resolve();
        const write = f.write("new", "windows"); f.exit(0); await write;
        resolve({ targets: ["text/plain"], text: Buffer.from("old"), imagePng: null, imageBmp: null, marker: "m" });
        expect((await read).text).toBe(latest); expect(captures).toBe(2); expect(f.state.cache?.text).toBe(latest);
    });
});
