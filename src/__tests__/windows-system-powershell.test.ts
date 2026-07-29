import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
    canonicalWindowsPowerShellPath,
    canonicalWindowsSystemExecutablePath,
    spawnableWindowsExecutablePath,
    terminateWindowsProcessByStartToken,
    windowsHandleBoundTerminationScript,
} from "../windows-system-powershell.js";

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

    it.runIf(process.platform === "win32")("resolves the trusted GLOBALROOT executable on Windows", () => {
        expect(canonicalWindowsPowerShellPath()).toMatch(
            /^[A-Za-z]:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i,
        );
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

    it("resolves only plain System32 executables without path traversal", () => {
        const root = mkdtempSync(join(tmpdir(), "ccc-system-executable-"));
        roots.push(root);
        const taskkill = join(root, "System32", "taskkill.exe");
        mkdirSync(dirname(taskkill), { recursive: true });
        writeFileSync(taskkill, "test");

        expect(canonicalWindowsSystemExecutablePath("taskkill.exe", root)).toBe(taskkill);
        expect(canonicalWindowsSystemExecutablePath("../taskkill.exe", root)).toBeNull();
        expect(canonicalWindowsSystemExecutablePath("", root)).toBeNull();
    });

    it.runIf(process.platform !== "win32")("passes process identity through environment to handle-bound termination", () => {
        const root = mkdtempSync(join(tmpdir(), "ccc-system-terminate-"));
        roots.push(root);
        const executable = join(root, "fake-powershell");
        const capture = join(root, "capture.txt");
        writeFileSync(executable, [
            "#!/bin/sh",
            "printf '%s\\n%s\\n' \"$CCC_WINDOWS_TERMINATE_PID\" \"$CCC_WINDOWS_TERMINATE_START_TOKEN\" > \"$CCC_TEST_CAPTURE\"",
            "exit 0",
        ].join("\n"));
        chmodSync(executable, 0o755);
        const previousCapture = process.env.CCC_TEST_CAPTURE;
        process.env.CCC_TEST_CAPTURE = capture;
        try {
            expect(terminateWindowsProcessByStartToken(321, "windows:2026-01-01T00:00:00.0000000Z", 1000, executable))
                .toEqual(expect.objectContaining({ ok: true, pid: 321, method: "process-handle" }));
            expect(readFileSync(capture, "utf8")).toBe("321\nwindows:2026-01-01T00:00:00.0000000Z\n");
        } finally {
            if (previousCapture === undefined) delete process.env.CCC_TEST_CAPTURE;
            else process.env.CCC_TEST_CAPTURE = previousCapture;
        }
    });

    it("fails closed without a Windows start token", () => {
        expect(terminateWindowsProcessByStartToken(321, "linux:123", 1000, "/missing"))
            .toEqual(expect.objectContaining({ ok: false, reason: "windows-process-identity-unavailable" }));
    });

    it("holds process handles while terminating the root and its descendant snapshot", () => {
        const script = windowsHandleBoundTerminationScript();
        expect(script).toContain("[Diagnostics.Process]::GetProcessById($RootPid)");
        expect(script).toContain("Select-Object ProcessId, ParentProcessId, CreationDate");
        expect(script).toContain("$ObservedToken -eq $SnapshotToken");
        expect(script).toContain("$Descendants.Add($Child)");
        expect(script).toContain("$Descendants[$Index].Kill()");
        expect(script).toContain("$Root.Kill()");
        expect(script).not.toContain("taskkill");
    });
});
