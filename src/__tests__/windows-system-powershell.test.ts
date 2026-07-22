import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalWindowsPowerShellPath, spawnableWindowsExecutablePath } from "../windows-system-powershell.js";

describe("canonical Windows PowerShell", () => {
    const roots: string[] = [];
    afterEach(() => {
        for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    });

    it("accepts only verified local executable paths", () => {
        expect(spawnableWindowsExecutablePath("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")).toMatch(/^C:/);
        expect(spawnableWindowsExecutablePath("powershell.exe")).toBeNull();
        expect(spawnableWindowsExecutablePath("\\\\server\\share\\powershell.exe")).toBeNull();
    });

    it("resolves a plain test system root and rejects a linked executable", () => {
        const root = mkdtempSync(join(tmpdir(), "ccc-system-powershell-"));
        roots.push(root);
        const executable = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        mkdirSync(dirname(executable), { recursive: true });
        writeFileSync(executable, "test");
        expect(canonicalWindowsPowerShellPath(root)).toBe(executable);

        rmSync(executable);
        const target = join(root, "foreign.exe");
        writeFileSync(target, "foreign");
        symlinkSync(target, executable, "file");
        expect(canonicalWindowsPowerShellPath(root)).toBeNull();
    });
});
