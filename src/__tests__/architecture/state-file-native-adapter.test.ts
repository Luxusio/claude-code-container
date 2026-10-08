import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, linkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as ts from "../../../packages/device-lab/src/device-lab-state-file.js";
import * as shared from "../../../packages/device-lab/providers/state/state-file.mjs";

const control = vi.hoisted(() => ({ trace: [] as string[], fault: null as { operation: string; error: Error } | null, partialWrite: false, zeroWrite: false, oversizeRead: false }));
vi.mock("fs", async importOriginal => {
    const fs = await importOriginal<typeof import("node:fs")>();
    return {
        ...fs,
        openSync: (...args: [string, number, number?]) => { control.trace.push("open"); if (control.fault?.operation === "open") throw control.fault.error; return fs.openSync(...args); },
        fstatSync: (...args: [number]) => { control.trace.push("fstat"); if (control.fault?.operation === "fstat") throw control.fault.error; return fs.fstatSync(...args); },
        lstatSync: (...args: [string]) => { control.trace.push("lstat"); if (control.fault?.operation === "lstat") throw control.fault.error; return fs.lstatSync(...args); },
        readSync: (...args: [number, Buffer, number, number, number | null]) => { control.trace.push("read"); if (control.fault?.operation === "read") throw control.fault.error; if (control.oversizeRead) return args[3]; return fs.readSync(...args); },
        ftruncateSync: (...args: Parameters<typeof fs.ftruncateSync>) => { control.trace.push("truncate"); return fs.ftruncateSync(...args); },
        writeSync: (descriptor: number, bytes: Buffer, offset: number, length: number) => { control.trace.push("write"); if (control.zeroWrite) return 0; return fs.writeSync(descriptor, bytes, offset, control.partialWrite ? Math.max(1, Math.floor(length / 2)) : length); },
        closeSync: (descriptor: number) => { control.trace.push("close"); fs.closeSync(descriptor); if (control.fault?.operation === "close") throw control.fault.error; },
    };
});

const roots: string[] = [];
function temporary() {
    const root = mkdtempSync(join(tmpdir(), "ccc-state-file-native-")); roots.push(root);
    const file = join(root, "state"); return { root, file };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); control.trace = []; control.fault = null; control.partialWrite = false; control.zeroWrite = false; control.oversizeRead = false; });

for (const [name, binding] of [["TS", ts], ["shared", shared]] as const) describe(`${name} native read compatibility`, () => {
    it("distinguishes missing, bounded exact bytes and actual max+1 growth", () => {
        const { file } = temporary();
        expect(binding.readDeviceLabBinaryFile(file, "f", 3)).toBeNull();
        writeFileSync(file, "abc"); expect(binding.readDeviceLabBinaryFile(file, "f", 3)?.toString()).toBe("abc");
        control.oversizeRead = true; expect(() => binding.readDeviceLabBinaryFile(file, "f", 3)).toThrow("f-file-too-large");
    });
    it("rejects oversized stat, symbolic links, hardlinks and nonordinary files", () => {
        const { root, file } = temporary(); writeFileSync(file, "abcd");
        expect(() => binding.readDeviceLabBinaryFile(file, "f", 3)).toThrow("f-file-too-large");
        const symbolic = join(root, "symbolic"); symlinkSync(file, symbolic);
        expect(() => binding.readDeviceLabBinaryFile(symbolic, "f", 99)).toThrow("f-state-invalid");
        linkSync(file, join(root, "hard")); expect(() => binding.readDeviceLabBinaryFile(file, "f", 99)).toThrow("f-state-invalid");
        expect(() => binding.readDeviceLabBinaryFile(root, "f", 99)).toThrow("f-state-invalid");
    });
    it("wraps pre-callback faults but preserves raw callback and read faults", () => {
        const { file } = temporary(); writeFileSync(file, "abc"); const fault = Error("native");
        control.fault = { operation: "fstat", error: fault };
        expect(() => binding.withDeviceLabReadableFile(file, "f", 99, () => true)).toThrow("f-state-read-failed");
        control.fault = null;
        try { binding.withDeviceLabReadableFile(file, "f", 99, () => { throw fault; }); } catch (error) { expect(error).toBe(fault); }
        control.fault = { operation: "read", error: fault };
        try { binding.readDeviceLabStateFile(file, (value: unknown) => value, "f"); } catch (error) { expect(error).toBe(fault); }
    });
    it("lets finally-close override success and callback failure", () => {
        const { file } = temporary(); writeFileSync(file, "abc"); const close = Error("close");
        control.fault = { operation: "close", error: close };
        for (const operation of [() => true, () => { throw Error("callback"); }]) {
            try { binding.withDeviceLabReadableFile(file, "f", 99, operation); } catch (error) { expect(error).toBe(close); }
        }
    });
});

describe("TS root-fenced in-place compatibility", () => {
    it("rejects lexical escape and linked parents before reading or truncating", () => {
        const { root, file } = temporary(); const outside = temporary(); writeFileSync(outside.file, "keep");
        expect(() => ts.assertDeviceLabPathWithinRoot(root, outside.file, "f")).toThrow("f-path-outside-root");
        symlinkSync(outside.root, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
        expect(() => ts.readDeviceLabBinaryFileWithinRoot(root, join(root, "linked", "state"), "f")).toThrow("f-path-invalid");
        expect(() => ts.writeDeviceLabBinaryFile(root, join(root, "linked", "state"), Buffer.from("bad"), "f")).toThrow("f-path-invalid");
        expect(readFileSync(outside.file, "utf8")).toBe("keep"); expect(control.trace).not.toContain("truncate");
        expect(file).toContain(root);
    });
    it("proves root and file before truncate, completes partial writes and verifies final bytes", () => {
        const { root, file } = temporary(); writeFileSync(file, "previous-content"); control.trace = []; control.partialWrite = true;
        ts.writeDeviceLabBinaryFile(root, file, Buffer.from("replacement"), "f");
        expect(readFileSync(file, "utf8")).toBe("replacement");
        expect(control.trace.indexOf("fstat")).toBeLessThan(control.trace.indexOf("truncate"));
        expect(control.trace.indexOf("lstat")).toBeLessThan(control.trace.indexOf("truncate"));
        expect(control.trace.filter(value => value === "write").length).toBeGreaterThan(1);
        expect(control.trace.at(-1)).toBe("close");
    });
    it("creates exclusively at root, requires nested create permission and refuses zero writes", () => {
        const { root, file } = temporary(); mkdirSync(join(root, "nested"));
        expect(() => ts.writeDeviceLabBinaryFile(root, join(root, "nested", "file"), Buffer.from("a"), "f")).toThrow("f-unsafe-create-parent");
        ts.writeDeviceLabBinaryFile(root, file, Buffer.from("created"), "f"); expect(readFileSync(file, "utf8")).toBe("created");
        ts.writeDeviceLabBinaryFile(root, join(root, "nested", "file"), Buffer.from("a"), "f", { allowNestedCreate: true });
        control.zeroWrite = true; expect(() => ts.writeDeviceLabBinaryFile(root, file, Buffer.from("x"), "f")).toThrow("f-state-write-failed");
    });
});
