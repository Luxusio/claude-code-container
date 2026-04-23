import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const icoPath = join(__dirname, "..", "..", "ui", "src-tauri", "icons", "icon.ico");

describe("ui/src-tauri/icons/icon.ico", () => {
    it("exists", () => {
        expect(existsSync(icoPath)).toBe(true);
    });

    it("is a valid ICO with a single entry and embedded PNG", () => {
        const buf = readFileSync(icoPath);
        expect(buf.length).toBeGreaterThanOrEqual(122);

        // ICONDIR
        expect(buf.readUInt16LE(0)).toBe(0); // reserved
        expect(buf.readUInt16LE(2)).toBe(1); // type=ICO
        expect(buf.readUInt16LE(4)).toBe(1); // count=1

        // ICONDIRENTRY at offset 6
        const bitcount = buf.readUInt16LE(6 + 6);
        expect(bitcount).toBe(32);
        const bytesize = buf.readUInt32LE(6 + 8);
        const offset = buf.readUInt32LE(6 + 12);
        expect(offset).toBe(22);
        expect(bytesize).toBeGreaterThan(0);

        // Embedded data starts with PNG magic
        const pngMagic = buf.slice(offset, offset + 8);
        expect(pngMagic.toString("hex")).toBe("89504e470d0a1a0a");

        // Total size matches header + entry + embedded payload
        expect(offset + bytesize).toBe(buf.length);
    });
});
