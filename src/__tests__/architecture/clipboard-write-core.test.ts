import { describe, expect, it } from "vitest";
import { createClipboardTextWriter } from "../../application/clipboard/text-write.js";
import { createClipboardSnapshotReader, createClipboardSnapshotState } from "../../application/clipboard/snapshot.js";
import type { ClipboardTextWritePorts, ClipboardTextWriteResult } from "../../ports/clipboard/text-write.js";
import type { ClipboardSnapshotPorts } from "../../ports/clipboard/snapshot.js";
import type { CapturedClipboardSnapshot } from "../../domain/clipboard/snapshot.js";

function fixture() {
    const calls: unknown[] = [];
    const state = createClipboardSnapshotState<Buffer>();
    state.cache = { timestamp: 0, targets: [], text: null, imagePng: null, imageBmp: null };
    let complete!: (result: ClipboardTextWriteResult) => void;
    let reject!: (error: unknown) => void;
    const pending = new Promise<ClipboardTextWriteResult>((resolve, fail) => { complete = resolve; reject = fail; });
    const ports: ClipboardTextWritePorts<Buffer> = {
        encodeText: text => { calls.push("encode"); return Buffer.from(text); },
        decodeText: bytes => { calls.push("decode"); return bytes.toString(); },
        prepareWriter: (bytes, platform) => {
            calls.push(["prepare", bytes, platform, state.generation]);
            return { kind: "ready", write: timeoutMs => {
                calls.push(["write", timeoutMs, state.generation, state.cache]);
                return pending;
            } };
        },
    };
    return { calls, ports, state, complete, reject, write: createClipboardTextWriter(ports, state) };
}

describe("Clipboard text-write application transaction", () => {
    it("admits faithful UTF8 before preparing and invalidates around bounded execution", async () => {
        const f = fixture(); const text = "\uFEFF한글 😀\r\n";
        const result = f.write(text, "darwin");
        expect(f.calls).toEqual(["encode", "decode", ["prepare", Buffer.from(text), "darwin", 0], ["write", 5000, 1, null]]);
        expect(f.state.generation).toBe(1);
        f.complete({ kind: "written" }); await result;
        expect(f.state.generation).toBe(2); expect(f.state.cache).toBeNull();
    });
    it.each(["nul", "oversize", "lossy", "unpaired-surrogate"])("rejects %s text before preparation or invalidation", async reason => {
        const f = fixture(); const cached = f.state.cache;
        if (reason === "lossy") f.ports.decodeText = () => "replacement";
        const text = reason === "nul" ? "a\0b" : reason === "oversize" ? "x".repeat(1048577) : reason === "unpaired-surrogate" ? "\uD800" : "valid";
        await expect(f.write(text, "linux-x11")).rejects.toThrow("Invalid clipboard text");
        expect(f.calls.some(call => Array.isArray(call))).toBe(false);
        expect(f.state.generation).toBe(0); expect(f.state.cache).toBe(cached);
    });
    it.each([
        { name: "empty", text: "" },
        { name: "ASCII boundary", text: "x".repeat(1048576) },
        { name: "multibyte boundary", text: "é".repeat(524288) },
    ])("accepts $name UTF8 text", async ({ text }) => {
        const f = fixture(); const result = f.write(text, "linux-x11");
        expect(f.calls).toContainEqual(["prepare", Buffer.from(text), "linux-x11", 0]);
        f.complete({ kind: "written" }); await result; expect(f.state.generation).toBe(2);
    });
    it("counts the UTF8 byte bound rather than characters", async () => {
        const f = fixture(); await expect(f.write("é".repeat(524289), "darwin")).rejects.toThrow("Invalid clipboard text");
        expect(f.state.generation).toBe(0); expect(f.calls).toEqual(["encode"]);
    });
    it("keeps unavailable preparation before invalidation", async () => {
        const f = fixture(); const cached = f.state.cache;
        f.ports.prepareWriter = () => ({ kind: "unavailable" });
        await expect(f.write("ok", "unsupported")).rejects.toThrow("Clipboard writer unavailable");
        expect(f.state.generation).toBe(0); expect(f.state.cache).toBe(cached);
    });
    it("propagates unexpected preparation failures without invalidation", async () => {
        const f = fixture(); const cached = f.state.cache; const failure = new Error("preparation fault");
        f.ports.prepareWriter = () => { throw failure; };
        await expect(f.write("ok", "windows")).rejects.toBe(failure);
        expect(f.state.generation).toBe(0); expect(f.state.cache).toBe(cached);
    });
    it("rejects failed completion and invalidates any intervening cache", async () => {
        const f = fixture(); const result = f.write("text", "linux-wayland");
        f.state.cache = { timestamp: 1, targets: ["text/plain"], text: Buffer.from("old"), imagePng: null, imageBmp: null };
        f.complete({ kind: "failed" }); await expect(result).rejects.toThrow("Clipboard write failed");
        expect(f.state.generation).toBe(2); expect(f.state.cache).toBeNull();
    });
    it.each(["synchronous", "asynchronous"])("finally invalidates after an unexpected %s execution failure", async mode => {
        const f = fixture(); const failure = new Error("execution fault");
        if (mode === "synchronous") f.ports.prepareWriter = () => ({ kind: "ready", write: () => { throw failure; } });
        const result = f.write("ok", "windows");
        if (mode === "asynchronous") f.reject(failure);
        await expect(result).rejects.toBe(failure);
        expect(f.state.generation).toBe(2); expect(f.state.cache).toBeNull();
    });
    it.each(["written", "failed"] as const)("suppresses an in-flight pre-write snapshot after %s completion", async kind => {
        const f = fixture(); let release!: (snapshot: CapturedClipboardSnapshot<Buffer>) => void;
        let started!: () => void;
        const captureStarted = new Promise<void>(resolve => { started = resolve; });
        const gate = new Promise<CapturedClipboardSnapshot<Buffer>>(resolve => { release = resolve; });
        const latest = Buffer.from("new"); let captures = 0;
        const ports: ClipboardSnapshotPorts<Buffer> = {
            now: () => 1,
            readChangeMarker: async () => ({ kind: "observed", marker: "m" }),
            capture: async () => {
                captures += 1; started();
                const snapshot = captures === 1 ? await gate : { targets: ["text/plain"], text: latest, imagePng: null, imageBmp: null, marker: "m" };
                return { kind: "captured", snapshot, fileReferences: [], textImagePaths: [] };
            },
            readImageFile: () => null, copyImageFile: () => null,
            createReadError: () => new Error("snapshot unavailable"),
        };
        const read = createClipboardSnapshotReader(ports, f.state)("windows", true);
        await captureStarted;
        const write = f.write("new", "windows"); f.complete({ kind });
        if (kind === "written") await write;
        else await expect(write).rejects.toThrow("Clipboard write failed");
        release({ targets: ["text/plain"], text: Buffer.from("old"), imagePng: null, imageBmp: null, marker: "m" });
        expect((await read).text).toBe(latest); expect(captures).toBe(2); expect(f.state.cache?.text).toBe(latest);
    });
});
