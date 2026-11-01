import * as childProcess from "child_process";
import { type ChildProcess } from "child_process";
import { EventEmitter } from "events";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PassThrough } from "stream";
import { fileURLToPath } from "url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startProcessTreeWatchdog } from "./process-tree-watchdog-lifecycle.ts";
import { runSupervisedProcess } from "./supervised-process.ts";

vi.mock("child_process", async original => ({ ...await original<typeof import("child_process")>() }));

function fakeChild(pid = 1234) {
    return Object.assign(new EventEmitter(), {
        pid, exitCode: null as number | null, signalCode: null,
        stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
        unref: vi.fn(), kill: vi.fn(() => true),
    }) as unknown as ChildProcess;
}

function watchdogFixture() {
    const watchdog = fakeChild();
    const stopped = vi.fn();
    vi.spyOn(childProcess, "spawn").mockReturnValue(watchdog);
    return { watchdog, stopped, lifecycle: startProcessTreeWatchdog(fakeChild(5678), {}, stopped) };
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe("real-test watchdog completion", () => {
    it("waits for close rather than exit before reporting completion", async () => {
        const f = watchdogFixture();
        let finished = false;
        const completion = f.lifecycle.complete().then(error => { finished = true; return error; });
        f.watchdog.emit("exit", 0, null);
        await Promise.resolve();
        expect(finished).toBe(false);
        f.watchdog.emit("close", 0, null);
        expect(await completion).toBeNull();
        expect(f.stopped).not.toHaveBeenCalled();
    });

    it("retains an early close and stops the now-unprotected worker", async () => {
        const f = watchdogFixture();
        f.watchdog.emit("close", 0, null);
        expect(f.stopped).toHaveBeenCalledOnce();
        expect(await f.lifecycle.complete()).toMatchObject({ message: "process tree watchdog closed before worker completion" });
    });

    it.each(["spawn", "stdin"])("handles an early %s error without losing its close", async source => {
        const f = watchdogFixture();
        const error = new Error(`${source} failed`);
        (source === "spawn" ? f.watchdog : f.watchdog.stdin).emit("error", error);
        f.watchdog.emit("close", 1, null);
        expect(f.stopped).toHaveBeenCalledOnce();
        expect(await f.lifecycle.complete()).toBe(error);
    });

    it("reports a synchronous watchdog spawn failure and stops only its worker", async () => {
        const error = new Error("spawn failed");
        vi.spyOn(childProcess, "spawn").mockImplementation(() => { throw error; });
        const stopped = vi.fn();
        const lifecycle = startProcessTreeWatchdog(fakeChild(), {}, stopped);
        expect(await lifecycle.complete()).toMatchObject({ message: "process tree watchdog failed to start", cause: error });
        expect(stopped).toHaveBeenCalledOnce();
    });

    it("does not launch a watchdog for a worker that failed to spawn", async () => {
        const spawn = vi.spyOn(childProcess, "spawn");
        const worker = fakeChild();
        Object.assign(worker, { pid: undefined });
        expect(await startProcessTreeWatchdog(worker, {}, vi.fn()).complete()).toBeNull();
        expect(spawn).not.toHaveBeenCalled();
    });

    it("bounds a failed close join and signals only the retained watchdog child", async () => {
        vi.useFakeTimers();
        const f = watchdogFixture();
        const completion = f.lifecycle.complete();
        expect(f.lifecycle.complete()).toBe(completion);
        await vi.advanceTimersByTimeAsync(5000);
        expect(f.watchdog.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
        await vi.advanceTimersByTimeAsync(1000);
        expect(await completion).toMatchObject({ message: "process tree watchdog did not close after worker completion" });
        expect(f.stopped).not.toHaveBeenCalled();
    });

    it.each(["error", "throw"])("preserves the worker failure when completion input has an %s", async source => {
        const child = fakeChild();
        const watchdog = fakeChild();
        vi.spyOn(childProcess, "spawn").mockReturnValueOnce(child).mockReturnValueOnce(watchdog);
        const primary = new Error("worker failed");
        const secondary = new Error("completion pipe failed");
        if (source === "throw") vi.spyOn(watchdog.stdin, "end").mockImplementation(() => { throw secondary; });
        const result = runSupervisedProcess("fixture", [], { capture: true });
        child.emit("error", primary);
        Object.assign(child, { exitCode: 7 });
        child.emit("close", 7, null);
        await Promise.resolve();
        if (source === "error") watchdog.stdin.emit("error", secondary);
        watchdog.emit("close", 1, null);
        expect(await result).toMatchObject({ status: 7, error: primary, watchdogError: secondary });
    });

    it("does not report success when watchdog completion fails", async () => {
        const child = fakeChild();
        const watchdog = fakeChild();
        vi.spyOn(childProcess, "spawn").mockReturnValueOnce(child).mockReturnValueOnce(watchdog);
        const result = runSupervisedProcess("fixture", [], { capture: true });
        Object.assign(child, { exitCode: 0 });
        child.emit("close", 0, null);
        await Promise.resolve();
        watchdog.emit("close", 1, null);
        expect(await result).toMatchObject({ status: 1, error: { message: "process tree watchdog failed: 1" } });
    });

    it("releases its temporary cwd before runSupervisedProcess returns", async () => {
        const root = mkdtempSync(join(tmpdir(), "ccc-supervised-cwd-"));
        try {
            const result = await runSupervisedProcess(process.execPath, ["-e", "process.stdout.write('finished')"], {
                cwd: root, capture: true, timeout: 10000,
            });
            expect(result, result.stderr).toMatchObject({ status: 0, stdout: "finished", error: null });
            // No retry: a detached watchdog still holding cwd fails here on Windows.
            rmSync(root, { recursive: true, force: true });
            expect(existsSync(root)).toBe(false);
        } finally { rmSync(root, { recursive: true, force: true }); }
    });

    it("retains worker-tree cleanup when the parent pipe closes without completion", async () => {
        const root = mkdtempSync(join(tmpdir(), "ccc-watchdog-parent-loss-"));
        let worker: ChildProcess;
        let watchdog: ChildProcess;
        let workerClosed: Promise<number | null>;
        let watchdogClosed: Promise<number | null>;
        const close = (child: ChildProcess) => new Promise<number | null>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("owned fixture child did not close")), 10000);
            child.once("error", error => { clearTimeout(timer); reject(error); });
            child.once("close", status => { clearTimeout(timer); resolve(status); });
        });
        try {
            worker = childProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
                cwd: root, stdio: "ignore", windowsHide: true, detached: process.platform !== "win32",
            });
            workerClosed = close(worker);
            watchdog = childProcess.spawn(process.execPath, [
                "--import", new URL("./typescript-source-loader.mjs", import.meta.url).href,
                fileURLToPath(new URL("./process-tree-watchdog.ts", import.meta.url)),
                String(worker.pid), String(process.pid),
            ], { cwd: root, stdio: ["pipe", "ignore", "ignore"], windowsHide: true, detached: true });
            watchdogClosed = close(watchdog);
            watchdog.stdin.end();
            const [, watchdogStatus] = await Promise.all([workerClosed, watchdogClosed]);
            expect(watchdogStatus).toBe(0);
            rmSync(root, { recursive: true, force: true });
            expect(existsSync(root)).toBe(false);
        } finally {
            if (watchdog && watchdog.exitCode === null && watchdog.signalCode === null) watchdog.kill("SIGKILL");
            if (worker && worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
            await Promise.allSettled([workerClosed, watchdogClosed].filter(Boolean));
            rmSync(root, { recursive: true, force: true });
        }
    });
});
