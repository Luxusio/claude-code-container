import { spawnSync } from "child_process";
import { writeSync } from "fs";

const terminalCleanup = "\x1b[?9l\x1b[?1000l\x1b[?1001l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1016l\x1b[?1004l\x1b[?2004l\x1b[?1049l\x1b[?1047l\x1b[?47l\x1b[?25h\x1b[0 q\x1b[0m";

/** Own only the inherited terminal's lifetime, without reading its input. */
export function captureInteractiveTerminal(): () => void {
    const input = process.stdin;
    const output = process.stdout;
    if (!input.isTTY || !output.isTTY) return () => {};

    const inputFd = input.fd;
    const outputFd = output.fd;
    const wasRaw = input.isRaw;
    const posix = process.platform !== "win32";
    function stty(args: string[]) {
        try {
            return spawnSync("stty", args, {
                encoding: "utf8", stdio: [inputFd, "pipe", "ignore"], shell: false,
                timeout: 250, killSignal: "SIGKILL", maxBuffer: 4096,
            });
        } catch { return undefined; }
    }
    const snapshot = posix ? stty(["-g"]) : undefined;
    const saved = snapshot?.status === 0 && !snapshot.error ? snapshot.stdout.trim() : "";
    let restored = false;
    function restore(): void {
        if (restored) return;
        restored = true;
        process.removeListener("exit", restore);
        if (posix) {
            const result = saved ? stty([saved]) : undefined;
            if (!result || result.status !== 0 || result.error) {
                stty(["sane"]);
                try { input.setRawMode(wasRaw); } catch { /* Best effort without a native snapshot. */ }
            }
        } else {
            try { input.setRawMode(wasRaw); } catch { /* Native console modes are best effort. */ }
        }
        // Synchronous output also survives the existing signal cleanup's process.exit().
        try { writeSync(outputFd, terminalCleanup); } catch { /* Preserve the child result. */ }
    }
    process.once("exit", restore);
    return restore;
}
