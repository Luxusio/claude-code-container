import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { readDeviceLabBinaryFileWithinRoot, writeDeviceLabBinaryFile } from "../device-lab-state-file.js";

describe("device-lab fenced file writes", () => {
    const roots: string[] = [];

    afterEach(() => {
        for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    });

    it("writes through a verified file descriptor and supports existing files", () => {
        const root = mkdtempSync(join(tmpdir(), "ccc-device-write-"));
        roots.push(root);
        const directory = join(root, "downloads");
        const file = join(directory, "result.bin");
        mkdirSync(directory);
        writeFileSync(file, "old-content");

        writeDeviceLabBinaryFile(root, file, Buffer.from("new-content"), "device-download");

        expect(readFileSync(file, "utf8")).toBe("new-content");
    });

    it("rejects a linked destination parent before opening the destination", () => {
        const root = mkdtempSync(join(tmpdir(), "ccc-device-write-root-"));
        const outside = mkdtempSync(join(tmpdir(), "ccc-device-write-outside-"));
        roots.push(root, outside);
        symlinkSync(outside, join(root, "downloads"), "dir");

        expect(() => writeDeviceLabBinaryFile(root, join(root, "downloads", "result.bin"), Buffer.from("blocked"), "device-download"))
            .toThrow("device-download-path-invalid");
        expect(() => readFileSync(join(outside, "result.bin"))).toThrow();
    });

    it("requires nested download destinations to exist before opening them", () => {
        const root = mkdtempSync(join(tmpdir(), "ccc-device-write-nested-"));
        roots.push(root);
        mkdirSync(join(root, "downloads"));

        expect(() => writeDeviceLabBinaryFile(root, join(root, "downloads", "result.bin"), Buffer.from("blocked"), "device-download"))
            .toThrow("device-download-unsafe-create-parent");
        expect(() => readFileSync(join(root, "downloads", "result.bin"))).toThrow();

        writeDeviceLabBinaryFile(root, join(root, "result.bin"), Buffer.from("created"), "device-download");
        expect(readFileSync(join(root, "result.bin"), "utf8")).toBe("created");
    });

    it("rejects a linked upload source parent while the source descriptor is open", () => {
        const root = mkdtempSync(join(tmpdir(), "ccc-device-read-root-"));
        const outside = mkdtempSync(join(tmpdir(), "ccc-device-read-outside-"));
        roots.push(root, outside);
        writeFileSync(join(outside, "secret.bin"), "outside");
        symlinkSync(outside, join(root, "uploads"), "dir");

        expect(() => readDeviceLabBinaryFileWithinRoot(root, join(root, "uploads", "secret.bin"), "device-upload"))
            .toThrow("device-upload-path-invalid");
    });
});
