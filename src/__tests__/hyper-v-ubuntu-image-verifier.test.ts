import { closeSync, ftruncateSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync } from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("Hyper-V Ubuntu image verifier", () => {
    const source = readFileSync(join(process.cwd(), "scripts", "verify-hyper-v-ubuntu-image.ts"), "utf8");

    it("only executes an attested qemu-img binary", () => {
        expect(source).toContain("realpathSync.native(path)");
        expect(source).toContain("candidate.uid !== 0 || (candidate.mode & 0o022) !== 0");
        expect(source).toContain("metadata.uid !== 0 || (metadata.mode & 0o022) !== 0");
        expect(source).toContain('join(localAppData, "Android", "Sdk", "emulator", "qemu-img.exe")');
        expect(source).toContain("Get-AuthenticodeSignature -LiteralPath $env:CCC_QEMU_IMG_VERIFY_PATH");
        expect(source).toContain("O=Google LLC");
        expect(source).toContain("[IO.FileShare]::Read)");
        expect(source).toContain("$HashBefore = Get-GuardedHash $Guard");
        expect(source).toContain("$HashAfter = Get-GuardedHash $Guard");
        expect(source).toContain("if ($HashAfter -ne $HashBefore) { exit 3 }");
        expect(source).toContain("hyper-v-image-verifier-qemu-img-untrusted-or-unavailable");
        expect(source).not.toContain('process.env.CCC_QEMU_IMG || "qemu-img"');
    });

    it("converts the pinned QCOW2 through fixed VHD without exposing child-process output", () => {
        expect(source).toContain('"convert", "-f", "qcow2", "-O", "vpc", "-o", "subformat=fixed,force_size=on"');
        expect(source).toContain('"convert", "-f", "vpc", "-O", "raw"');
        expect(source).toContain('throw new Error("hyper-v-image-verifier-convert-failed")');
        expect(source).toContain('throw new Error("hyper-v-image-verifier-raw-convert-failed")');
        expect(source).not.toContain("conversion.stderr");
        expect(source).not.toContain("rawConversion.stderr");
        expect(source).not.toContain("conversion.error?.message");
        expect(source).not.toContain("rawConversion.error?.message");
    });

    it.runIf(spawnSync("qemu-img", ["--version"], { stdio: "ignore" }).status === 0)(
        "compares fixed VHD content with a larger zero-tailed VHDX and rejects changed sectors",
        () => {
            const root = mkdtempSync(join(tmpdir(), "ccc-qemu-compare-"));
            const sourceRaw = join(root, "source.raw");
            const targetRaw = join(root, "target.raw");
            const changedRaw = join(root, "changed.raw");
            const sourceVhd = join(root, "source.vhd");
            const targetVhdx = join(root, "target.vhdx");
            const changedVhdx = join(root, "changed.vhdx");
            const writeSector = (path: string, size: number, byte: string) => {
                const handle = openSync(path, "w+");
                try {
                    ftruncateSync(handle, size);
                    writeSync(handle, Buffer.from(byte), 0, 1, 4096);
                } finally {
                    closeSync(handle);
                }
            };
            const qemu = (...args: string[]) => spawnSync("qemu-img", args, { encoding: "utf8" });

            try {
                writeSector(sourceRaw, 16 * 1024 * 1024, "x");
                writeSector(targetRaw, 32 * 1024 * 1024, "x");
                writeSector(changedRaw, 16 * 1024 * 1024, "y");
                expect(qemu("convert", "-f", "raw", "-O", "vpc", "-o", "subformat=fixed,force_size=on", sourceRaw, sourceVhd).status).toBe(0);
                expect(qemu("convert", "-f", "raw", "-O", "vhdx", targetRaw, targetVhdx).status).toBe(0);
                expect(qemu("convert", "-f", "raw", "-O", "vhdx", changedRaw, changedVhdx).status).toBe(0);
                expect(qemu("compare", "-f", "vpc", "-F", "vhdx", sourceVhd, targetVhdx).status).toBe(0);
                expect(qemu("compare", "-f", "vpc", "-F", "vhdx", sourceVhd, changedVhdx).status).toBe(1);
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        },
    );
});
