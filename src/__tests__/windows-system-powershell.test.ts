import * as childProcess from "child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fileSymlinkOrSkip } from "./helpers/file-symlink-fixture.js";
import {
    canonicalWindowsPowerShellPath,
    canonicalWindowsPowerShellPathAsync,
    canonicalWindowsTasklistPath,
    canonicalWindowsSystemExecutablePath,
    hiddenWindowsPowerShellArgs,
    spawnableWindowsExecutablePath,
    terminateWindowsProcessByStartToken,
    terminateWindowsProcessByStartTokenAsync,
    windowsHandleBoundTerminationScript,
} from "@ccc/device-lab/windows-system-powershell.js";

vi.mock("child_process", async (importOriginal) => ({
    ...await importOriginal<typeof import("child_process")>(),
}));

afterEach(() => vi.restoreAllMocks());

const ownedWindowsStartToken = "windows:2026-01-01T00:00:00.1234567Z";

function terminationResult(status: number | null, stderr = "", error?: Error): childProcess.SpawnSyncReturns<string> {
    return { pid: 321, output: [null, "", stderr], stdout: "", stderr, status, signal: null, ...(error ? { error } : {}) };
}

function mockTermination(result = terminationResult(0), afterTermination?: () => void) {
    return vi.spyOn(childProcess, "spawnSync").mockImplementation(() => {
        afterTermination?.();
        return result;
    });
}

function terminationDurations(spawn: ReturnType<typeof mockTermination>) {
    const options = spawn.mock.calls[0][2] as childProcess.SpawnSyncOptions;
    return {
        outer: options.timeout as number,
        inner: Number(options.env?.CCC_WINDOWS_TERMINATE_TIMEOUT_MS),
    };
}

function mockDeferredTermination() {
    type Callback = (error: childProcess.ExecFileException | null, stdout: string, stderr: string) => void;
    let complete!: Callback;
    const execute = vi.spyOn(childProcess, "execFile").mockImplementation(((_file: string, _args: readonly string[], _options: childProcess.ExecFileOptions, callback: Callback) => {
        complete = callback;
        return {} as childProcess.ChildProcess;
    }) as typeof childProcess.execFile);
    return { execute, complete: (...args: Parameters<Callback>) => complete(...args) };
}

function asyncTerminationDurations(execute: ReturnType<typeof mockDeferredTermination>["execute"]) {
    const options = execute.mock.calls[0][2] as childProcess.ExecFileOptions;
    return { outer: options.timeout as number, inner: Number(options.env?.CCC_WINDOWS_TERMINATE_TIMEOUT_MS) };
}

function nextEventLoopTurn(): Promise<void> {
    return new Promise(resolve => setImmediate(resolve));
}

describe("canonical Windows PowerShell", () => {
    const roots: string[] = [];
    afterEach(() => {
        for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    });

    it("forces hidden PowerShell startup and replaces conflicting caller policies", () => {
        expect(hiddenWindowsPowerShellArgs(["-NoProfile", "-Command", "exit 0"])).toEqual([
            "-WindowStyle",
            "Hidden",
            "-NoProfile",
            "-Command",
            "exit 0",
        ]);
        expect(hiddenWindowsPowerShellArgs([
            "-NoProfile",
            "-WindowStyle", "Normal",
            "-WindowStyle:Minimized",
            "-Command",
            "exit 0",
        ])).toEqual([
            "-WindowStyle",
            "Hidden",
            "-NoProfile",
            "-Command",
            "exit 0",
        ]);
        expect(hiddenWindowsPowerShellArgs([
            "-w",
            "Normal",
            "-WindowS:Minimized",
            "-NoProfile",
        ])).toEqual([
            "-WindowStyle",
            "Hidden",
            "-NoProfile",
        ]);
        expect(hiddenWindowsPowerShellArgs(["-WindowS:Normal", "payload"])).toEqual([
            "-WindowStyle",
            "Hidden",
            "payload",
        ]);
        expect(hiddenWindowsPowerShellArgs([
            "-WindowStyle",
            "Normal",
            "-File",
            "script.ps1",
            "-w",
            "Normal",
        ])).toEqual([
            "-WindowStyle",
            "Hidden",
            "-File",
            "script.ps1",
            "-w",
            "Normal",
        ]);
        expect(hiddenWindowsPowerShellArgs(["-Command", "Write-Output", "-WindowStyle", "Normal"])).toEqual([
            "-WindowStyle",
            "Hidden",
            "-Command",
            "Write-Output",
            "-WindowStyle",
            "Normal",
        ]);
        expect(hiddenWindowsPowerShellArgs([
            "-CommandWithArgs",
            "Write-Output $args",
            "-WindowStyle",
            "Normal",
        ])).toEqual([
            "-WindowStyle",
            "Hidden",
            "-CommandWithArgs",
            "Write-Output $args",
            "-WindowStyle",
            "Normal",
        ]);
        expect(hiddenWindowsPowerShellArgs(["-cwa", "Write-Output $args", "-w", "Normal"])).toEqual([
            "-WindowStyle",
            "Hidden",
            "-cwa",
            "Write-Output $args",
            "-w",
            "Normal",
        ]);
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

    it("resolves a plain test system root", () => {
        const root = mkdtempSync(join(tmpdir(), "ccc-system-powershell-"));
        roots.push(root);
        const executable = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        mkdirSync(dirname(executable), { recursive: true });
        writeFileSync(executable, "test");
        expect(canonicalWindowsPowerShellPath(root)).toBe(executable);
    });

    it("rejects a linked executable", context => {
        const root = mkdtempSync(join(tmpdir(), "ccc-system-powershell-linked-"));
        roots.push(root);
        const executable = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        mkdirSync(dirname(executable), { recursive: true });
        const target = join(root, "foreign.exe");
        writeFileSync(target, "foreign");
        fileSymlinkOrSkip(context, target, executable);
        expect(canonicalWindowsPowerShellPath(root)).toBeNull();
    });

    it("resolves a plain test system root through the async PowerShell resolver", async () => {
        const root = mkdtempSync(join(tmpdir(), "ccc-system-powershell-async-"));
        roots.push(root);
        const executable = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        mkdirSync(dirname(executable), { recursive: true });
        writeFileSync(executable, "test");
        expect(await canonicalWindowsPowerShellPathAsync(root)).toBe(executable);
    });

    it("rejects a linked executable through the async PowerShell resolver", async context => {
        const root = mkdtempSync(join(tmpdir(), "ccc-system-powershell-async-linked-"));
        roots.push(root);
        const executable = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        mkdirSync(dirname(executable), { recursive: true });
        const target = join(root, "foreign.exe");
        writeFileSync(target, "foreign");
        fileSymlinkOrSkip(context, target, executable);
        expect(await canonicalWindowsPowerShellPathAsync(root)).toBeNull();
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

    it("resolves tasklist only through the verified System32 path", () => {
        const root = mkdtempSync(join(tmpdir(), "ccc-system-tasklist-"));
        roots.push(root);
        const tasklist = join(root, "System32", "tasklist.exe");
        mkdirSync(dirname(tasklist), { recursive: true });
        writeFileSync(tasklist, "test");

        expect(canonicalWindowsTasklistPath(root)).toBe(tasklist);
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
        expect(script).toContain("($ObservedTicks - ($ObservedTicks % 10)) -eq $SnapshotTicks");
        expect(script).toContain("$Descendants.Add($Child)");
        expect(script).toContain("$Descendants[$Index].Kill()");
        expect(script).toContain("$Root.Kill()");
        expect(script).not.toContain("taskkill");
    });
});

describe("Windows handle termination remaining allowance", () => {
    it.each([
        { timeoutMs: undefined, inner: 10_000, outer: 11_000 },
        { timeoutMs: 250, inner: 250, outer: 1250 },
        { timeoutMs: 1000, inner: 1000, outer: 2000 },
    ])("preserves omitted-budget limits for timeout $timeoutMs", ({ timeoutMs, inner, outer }) => {
        const spawn = mockTermination();

        expect(terminateWindowsProcessByStartToken(321, ownedWindowsStartToken, timeoutMs, "trusted-powershell.exe"))
            .toEqual(expect.objectContaining({ ok: true, pid: 321, status: 0, method: "process-handle" }));
        expect(terminationDurations(spawn)).toEqual({ inner, outer });
        expect((spawn.mock.calls[0][2] as childProcess.SpawnSyncOptions).env).toEqual(expect.objectContaining({
            CCC_WINDOWS_TERMINATE_PID: "321",
            CCC_WINDOWS_TERMINATE_START_TOKEN: ownedWindowsStartToken,
        }));
    });

    it.each([37.9, 1.9])("fits both the inner wait and outer observation into a fractional allowance (%s)", (remaining) => {
        const spawn = mockTermination();

        expect(terminateWindowsProcessByStartToken(321, ownedWindowsStartToken, 1000, "trusted-powershell.exe", () => remaining))
            .toEqual(expect.objectContaining({ ok: true, pid: 321, status: 0, method: "process-handle" }));
        expect(spawn).toHaveBeenCalledTimes(1);
        const { inner, outer } = terminationDurations(spawn);
        expect(Number.isInteger(inner)).toBe(true);
        expect(Number.isInteger(outer)).toBe(true);
        expect(inner).toBeGreaterThan(0);
        expect(outer).toBeGreaterThan(0);
        expect(inner).toBeLessThanOrEqual(Math.floor(remaining));
        expect(outer).toBeLessThanOrEqual(Math.floor(remaining));
        expect(inner).toBeLessThanOrEqual(outer);
    });

    it("retains primitive upper limits when the supplied allowance is larger", () => {
        const spawn = mockTermination();

        expect(terminateWindowsProcessByStartToken(321, ownedWindowsStartToken, 1000, "trusted-powershell.exe", () => 40_000).ok).toBe(true);
        const { inner, outer } = terminationDurations(spawn);
        expect(inner).toBeGreaterThan(0);
        expect(inner).toBeLessThanOrEqual(1000);
        expect(outer).toBeGreaterThanOrEqual(inner);
        expect(outer).toBeLessThanOrEqual(2000);
    });

    it.each([0, -1, 0.9, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
        "refuses a present unusable allowance (%s) before native termination",
        (remaining) => {
            const spawn = mockTermination();

            expect(terminateWindowsProcessByStartToken(321, ownedWindowsStartToken, 1000, "trusted-powershell.exe", () => remaining).ok)
                .toBe(false);
            expect(spawn).not.toHaveBeenCalled();
        },
    );

    it("refuses late successful termination without changing its observed native status", () => {
        let remaining = 70;
        const spawn = mockTermination(terminationResult(0), () => { remaining = 0; });

        expect(terminateWindowsProcessByStartToken(321, ownedWindowsStartToken, 1000, "trusted-powershell.exe", () => remaining))
            .toEqual(expect.objectContaining({ ok: false, pid: 321, status: 0, method: "process-handle" }));
        expect(terminationDurations(spawn).outer).toBeLessThanOrEqual(70);
    });

    it.each([
        { status: 3, stderr: "identity refused", reason: "process-start-token-mismatch" },
        { status: 4, stderr: "handle wait failed", reason: "process-termination-timeout" },
        { status: 7, stderr: "native access denied", reason: undefined },
    ])("preserves native failure $status after allowance expiry", ({ status, stderr, reason }) => {
        let remaining = 70;
        mockTermination(terminationResult(status, stderr), () => { remaining = 0; });

        const result = terminateWindowsProcessByStartToken(321, ownedWindowsStartToken, 1000, "trusted-powershell.exe", () => remaining);
        expect(result).toEqual(expect.objectContaining({ ok: false, pid: 321, status, error: stderr, method: "process-handle" }));
        expect(result.reason).toBe(reason);
    });

    it("preserves a genuine native transport error after allowance expiry", () => {
        let remaining = 70;
        mockTermination(terminationResult(null, "", new Error("native executable unavailable")), () => { remaining = 0; });

        const result = terminateWindowsProcessByStartToken(321, ownedWindowsStartToken, 1000, "trusted-powershell.exe", () => remaining);
        expect(result).toEqual(expect.objectContaining({ ok: false, status: null, error: "native executable unavailable" }));
        expect(result.reason).toBeUndefined();
    });

    it("still refuses unavailable identity before any budgeted native action", () => {
        const spawn = mockTermination();

        expect(terminateWindowsProcessByStartToken(321, "linux:123", 1000, "trusted-powershell.exe", () => 70))
            .toEqual(expect.objectContaining({ ok: false, reason: "windows-process-identity-unavailable" }));
        expect(spawn).not.toHaveBeenCalled();
    });
});

describe("asynchronous Windows handle termination", () => {
    it("awaits the native handle-bound command while the event loop remains responsive", async () => {
        const synchronousTermination = vi.spyOn(childProcess, "spawnSync");
        const native = mockDeferredTermination();
        let settled = false;
        const pending = terminateWindowsProcessByStartTokenAsync(321, ownedWindowsStartToken, 1000, "trusted-powershell.exe", () => 70.9)
            .then(result => { settled = true; return result; });

        await nextEventLoopTurn();
        expect(settled).toBe(false);
        expect(native.execute).toHaveBeenCalledTimes(1);
        expect(synchronousTermination).not.toHaveBeenCalled();
        expect(native.execute.mock.calls[0][0]).toBe("trusted-powershell.exe");
        expect(native.execute.mock.calls[0][1]).toEqual(hiddenWindowsPowerShellArgs([
            "-NoProfile", "-NonInteractive", "-Command", windowsHandleBoundTerminationScript(),
        ]));
        expect((native.execute.mock.calls[0][2] as childProcess.ExecFileOptions).env).toEqual(expect.objectContaining({
            CCC_WINDOWS_TERMINATE_PID: "321", CCC_WINDOWS_TERMINATE_START_TOKEN: ownedWindowsStartToken,
        }));
        expect((native.execute.mock.calls[0][2] as childProcess.ExecFileOptions).windowsHide).toBe(true);
        const { inner, outer } = asyncTerminationDurations(native.execute);
        expect(inner).toBeGreaterThan(0);
        expect(inner).toBeLessThanOrEqual(70);
        expect(outer).toBeGreaterThanOrEqual(inner);
        expect(outer).toBeLessThanOrEqual(70);
        native.complete(null, "", "");

        expect(await pending).toEqual(expect.objectContaining({ ok: true, pid: 321, status: 0, method: "process-handle" }));
    });

    it.each([
        { timeoutMs: undefined, inner: 10_000, outer: 11_000 },
        { timeoutMs: 250, inner: 250, outer: 1250 },
        { timeoutMs: 1000, inner: 1000, outer: 2000 },
    ])("preserves the omitted parent budget for async timeout $timeoutMs", async ({ timeoutMs, inner, outer }) => {
        const native = mockDeferredTermination();
        const pending = terminateWindowsProcessByStartTokenAsync(321, ownedWindowsStartToken, timeoutMs, "trusted-powershell.exe");
        await nextEventLoopTurn();
        expect(asyncTerminationDurations(native.execute)).toEqual({ inner, outer });
        native.complete(null, "", "");
        expect((await pending).ok).toBe(true);
    });

    it.each([37.9, 1.9])("bounds both async native waits by a fractional parent allowance %s", async remaining => {
        const native = mockDeferredTermination();
        const pending = terminateWindowsProcessByStartTokenAsync(321, ownedWindowsStartToken, 1000, "trusted-powershell.exe", () => remaining);
        await nextEventLoopTurn();
        const { inner, outer } = asyncTerminationDurations(native.execute);
        expect(Number.isInteger(inner)).toBe(true);
        expect(Number.isInteger(outer)).toBe(true);
        expect(inner).toBeGreaterThan(0);
        expect(inner).toBeLessThanOrEqual(outer);
        expect(outer).toBeLessThanOrEqual(Math.floor(remaining));
        native.complete(null, "", "");
        expect((await pending).ok).toBe(true);
    });

    it.each([0, -1, 0.9, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
        "refuses spent async parent allowance %s before native execution",
        async remaining => {
            const native = mockDeferredTermination();
            expect(await terminateWindowsProcessByStartTokenAsync(321, ownedWindowsStartToken, 1000, "trusted-powershell.exe", () => remaining))
                .toEqual(expect.objectContaining({ ok: false, pid: 321, reason: "process-termination-timeout" }));
            expect(native.execute).not.toHaveBeenCalled();
        },
    );

    it("refuses late native success after a deferred command consumes its parent allowance", async () => {
        const native = mockDeferredTermination();
        let remaining = 70;
        const pending = terminateWindowsProcessByStartTokenAsync(321, ownedWindowsStartToken, 1000, "trusted-powershell.exe", () => remaining);
        await nextEventLoopTurn();
        remaining = 0;
        native.complete(null, "", "");

        expect(await pending).toEqual(expect.objectContaining({ ok: false, pid: 321, status: 0, method: "process-handle", reason: "process-termination-timeout" }));
    });

    it.each([
        { status: 3, stderr: "identity refused", reason: "process-start-token-mismatch" },
        { status: 4, stderr: "handle wait failed", reason: "process-termination-timeout" },
        { status: 7, stderr: "native access denied", reason: undefined },
    ])("preserves async native failure $status when the parent allowance also expires", async ({ status, stderr, reason }) => {
        const native = mockDeferredTermination();
        let remaining = 70;
        const pending = terminateWindowsProcessByStartTokenAsync(321, ownedWindowsStartToken, 1000, "trusted-powershell.exe", () => remaining);
        await nextEventLoopTurn();
        remaining = 0;
        native.complete(Object.assign(new Error("native command failed"), { code: status }), "", stderr);

        const result = await pending;
        expect(result).toEqual(expect.objectContaining({ ok: false, pid: 321, status, error: stderr, method: "process-handle" }));
        expect(result.reason).toBe(reason);
    });

    it("preserves a deferred native transport error without reporting clean exit", async () => {
        const native = mockDeferredTermination();
        const pending = terminateWindowsProcessByStartTokenAsync(321, ownedWindowsStartToken, 1000, "trusted-powershell.exe");
        await nextEventLoopTurn();
        native.complete(Object.assign(new Error("native executable unavailable"), { code: "ENOENT" }), "", "");

        expect(await pending).toEqual(expect.objectContaining({ ok: false, status: null, error: "native executable unavailable" }));
    });

    it("refuses a missing qualified Windows identity before the async command", async () => {
        const native = mockDeferredTermination();
        expect(await terminateWindowsProcessByStartTokenAsync(321, "linux:123", 1000, "trusted-powershell.exe"))
            .toEqual(expect.objectContaining({ ok: false, reason: "windows-process-identity-unavailable" }));
        expect(native.execute).not.toHaveBeenCalled();
    });
});
