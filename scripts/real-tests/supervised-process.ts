import { spawn, spawnSync } from "child_process";
import { startProcessTreeWatchdog } from "./process-tree-watchdog-lifecycle.ts";

const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;

function terminateChildTree(child, force = false) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === "win32" && Number.isInteger(child.pid)) {
        spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
            stdio: "ignore",
            windowsHide: true,
            timeout: 5000,
        });
        return;
    }
    try {
        process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
    } catch {
        try {
            child.kill(force ? "SIGKILL" : "SIGTERM");
        } catch {
            // The child already exited.
        }
    }
}

export async function runSupervisedProcess(command: string, args: string[], options: any = {}) {
    const capture = options.capture === true;
    const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
        windowsHide: true,
        detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let capturedBytes = 0;
    let captureExceeded = false;
    const append = (target: "stdout" | "stderr", chunk: unknown) => {
        const text = String(chunk);
        capturedBytes += Buffer.byteLength(text);
        if (capturedBytes > (options.maxBufferBytes || MAX_CAPTURE_BYTES)) {
            captureExceeded = true;
            terminateChildTree(child, true);
            return;
        }
        if (target === "stdout") stdout += text;
        else stderr += text;
    };
    child.stdout?.setEncoding("utf-8");
    child.stderr?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk) => append("stdout", chunk));
    child.stderr?.on("data", (chunk) => append("stderr", chunk));

    let interruptedStatus: number | null = null;
    const signalHandlers = new Map<NodeJS.Signals, () => void>();
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
        const handler = () => {
            interruptedStatus = signal === "SIGINT" ? 130 : 143;
            terminateChildTree(child);
        };
        signalHandlers.set(signal, handler);
        process.once(signal, handler);
    }

    let timedOut = false;
    const timer = options.timeout
        ? setTimeout(() => {
            timedOut = true;
            terminateChildTree(child, true);
        }, options.timeout)
        : null;

    let childError: Error | null = null;
    const outcomePromise = new Promise<any>((resolvePromise) => {
        child.once("error", cause => { childError = cause; });
        child.once("close", (status, signal) => resolvePromise({ status, signal, error: childError }));
    });
    const watchdog = startProcessTreeWatchdog(child, options, () => terminateChildTree(child, true));
    const observed = await watchdog.waitForWorker(outcomePromise);
    const outcome = observed.confirmed === true ? observed.outcome : {
        status: child.exitCode, signal: child.signalCode, error: childError || observed.error,
    };
    if (timer) clearTimeout(timer);
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
    const watchdogError = await watchdog.complete();

    return {
        status: interruptedStatus ?? (outcome.status === 0 && watchdogError ? 1 : outcome.status),
        signal: outcome.signal,
        stdout,
        stderr,
        error: outcome.error || (captureExceeded ? new Error("supervised process output exceeded capture limit") : null) || watchdogError,
        watchdogError,
        workerCloseConfirmed: observed.confirmed,
        timedOut,
    };
}
