import { spawn, type ChildProcess } from "child_process";
import { fileURLToPath } from "url";

const WATCHDOG_CLOSE_MS = 5000;
const WATCHDOG_KILL_CLOSE_MS = 1000;
const UNPROTECTED_WORKER_CLOSE_MS = 5000;
export const WATCHDOG_TREE_TERMINATE_MS = 5000;
export const WATCHDOG_TREE_ESCALATE_MS = 1000;

export function startProcessTreeWatchdog(
    worker: ChildProcess,
    options: { cwd?: string; env?: NodeJS.ProcessEnv },
    onFailure: () => void,
) {
    let completionRequested = false;
    let workerCloseConfirmed = true;
    let failure: Error | null = null;
    let resolveFailure: (error: Error) => void;
    const failed = new Promise<Error>(resolve => { resolveFailure = resolve; });
    let closed = false;
    let resolveClosed: () => void;
    const close = new Promise<void>(resolve => { resolveClosed = resolve; });
    const fail = (error: Error) => {
        if (failure) return;
        failure = error;
        resolveFailure(error);
        if (!completionRequested) onFailure();
    };
    let watchdog: ChildProcess | null = null;
    if (Number.isInteger(worker.pid)) {
        try {
            watchdog = spawn(process.execPath, [
                "--import", new URL("./typescript-source-loader.mjs", import.meta.url).href,
                fileURLToPath(new URL("./process-tree-watchdog.ts", import.meta.url)),
                String(worker.pid), String(process.pid),
            ], {
                cwd: options.cwd, env: options.env,
                stdio: ["pipe", "ignore", "ignore"], windowsHide: true, detached: true,
            });
        } catch (error) {
            fail(new Error("process tree watchdog failed to start", { cause: error }));
        }
    }
    watchdog?.once("error", error => fail(error));
    watchdog?.stdin?.on("error", error => fail(error));
    watchdog?.once("close", (status, signal) => {
        closed = true;
        if (!completionRequested) fail(new Error("process tree watchdog closed before worker completion"));
        else if (status !== 0) fail(new Error(`process tree watchdog failed: ${signal || status}`));
        resolveClosed();
    });
    watchdog?.unref();
    (watchdog?.stdin as any)?.unref?.();

    const waitForClose = async (timeoutMs: number) => {
        if (closed) return true;
        let timer: ReturnType<typeof setTimeout>;
        try {
            return await Promise.race([
                close.then(() => true),
                new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
            ]);
        } finally { clearTimeout(timer); }
    };
    let completion: Promise<Error | null> | undefined;
    return {
        waitForWorker: <T>(outcome: Promise<T>) => new Promise<
            { confirmed: true; outcome: T } | { confirmed: false; error: Error }
        >((resolve, reject) => {
            workerCloseConfirmed = false;
            let settled = false;
            let timer: ReturnType<typeof setTimeout>;
            const finish = (result: () => void) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                result();
            };
            outcome.then(value => finish(() => {
                workerCloseConfirmed = true;
                resolve({ confirmed: true, outcome: value });
            }), error => finish(() => {
                workerCloseConfirmed = true;
                reject(error);
            }));
            failed.then(error => {
                if (settled) return;
                // Normal VM work has no added deadline. Only loss of watchdog
                // protection bounds this otherwise unconfirmed worker close.
                timer = setTimeout(() => finish(() => {
                    worker.unref();
                    worker.stdio.forEach(stream => (stream as any)?.unref?.());
                    resolve({ confirmed: false, error: new Error(
                        "worker close could not be confirmed after process tree watchdog failure",
                        { cause: error },
                    ) });
                }), UNPROTECTED_WORKER_CLOSE_MS);
            });
        }),
        complete: () => completion ??= (async () => {
            completionRequested = true;
            if (watchdog && !closed) {
                try {
                    if (!watchdog.stdin) throw new Error("process tree watchdog completion input is unavailable");
                    watchdog.stdin.end(workerCloseConfirmed ? "complete" : undefined);
                } catch (error) { fail(error as Error); }
                const closeAllowance = WATCHDOG_CLOSE_MS + (workerCloseConfirmed
                    ? 0 : 2 * WATCHDOG_TREE_TERMINATE_MS + WATCHDOG_TREE_ESCALATE_MS);
                if (!await waitForClose(closeAllowance)) {
                    fail(new Error("process tree watchdog did not close after worker completion"));
                    // Only the retained owned child may be signalled. Never recover a
                    // watchdog by querying or killing an arbitrary/reused PID.
                    try { watchdog.kill("SIGKILL"); } catch { /* report the original close failure */ }
                    await waitForClose(WATCHDOG_KILL_CLOSE_MS);
                }
            }
            return failure;
        })(),
    };
}
