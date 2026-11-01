import { spawn, type ChildProcess } from "child_process";
import { fileURLToPath } from "url";

const WATCHDOG_CLOSE_MS = 5000;
const WATCHDOG_KILL_CLOSE_MS = 1000;

export function startProcessTreeWatchdog(
    worker: ChildProcess,
    options: { cwd?: string; env?: NodeJS.ProcessEnv },
    onFailure: () => void,
) {
    if (!Number.isInteger(worker.pid)) return { complete: async () => null as Error | null };

    let completionRequested = false;
    let failure: Error | null = null;
    let closed = false;
    let resolveClosed: () => void;
    const close = new Promise<void>(resolve => { resolveClosed = resolve; });
    const fail = (error: Error) => {
        if (failure) return;
        failure = error;
        if (!completionRequested) onFailure();
    };
    let watchdog: ChildProcess;
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
        return { complete: async () => failure };
    }
    watchdog.once("error", error => fail(error));
    watchdog.stdin?.on("error", error => fail(error));
    watchdog.once("close", (status, signal) => {
        closed = true;
        if (!completionRequested) fail(new Error("process tree watchdog closed before worker completion"));
        else if (status !== 0) fail(new Error(`process tree watchdog failed: ${signal || status}`));
        resolveClosed();
    });
    watchdog.unref();
    (watchdog.stdin as any)?.unref?.();

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
        complete: () => completion ??= (async () => {
            completionRequested = true;
            if (!closed) {
                try {
                    if (!watchdog.stdin) throw new Error("process tree watchdog completion input is unavailable");
                    watchdog.stdin.end("complete");
                } catch (error) { fail(error as Error); }
                if (!await waitForClose(WATCHDOG_CLOSE_MS)) {
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
