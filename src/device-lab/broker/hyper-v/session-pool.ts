import { spawn } from "child_process";

import {
    createHyperVWindowsPowerShellSession,
    type HyperVWindowsSession,
    type HyperVWindowsSessionProcess,
} from "../../../hyper-v-windows/index.js";
import { hiddenWindowsPowerShellArgs } from "../../../windows-system-powershell.js";

// One session per PowerShell executable, for the life of the broker. Keyed by executable rather
// than by owner: the session carries no owner state — every request names its own VM by id, and the
// library validates that — so sharing one is safe and is what makes the reuse worth having. Keying
// per owner would reintroduce the process-per-flow cost this exists to remove.
const sessions = new Map<string, HyperVWindowsSession>();

const MAX_LINE_BYTES = 512 * 1024;

function sessionProcess(executable: string, bootstrap: string): HyperVWindowsSessionProcess {
    const child = spawn(executable, hiddenWindowsPowerShellArgs([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        bootstrap,
    ]), { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });

    const lineListeners: Array<(line: string) => void> = [];
    const exitListeners: Array<(reason: string) => void> = [];
    let buffered = "";

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
        buffered += chunk;
        // A child that never emits a newline must not grow this without bound. Dropping the buffer
        // makes the pending request time out, which discards the session, rather than consuming
        // memory until the broker dies.
        if (Buffer.byteLength(buffered, "utf8") > MAX_LINE_BYTES) {
            buffered = "";
            return;
        }
        let index = buffered.indexOf("\n");
        while (index >= 0) {
            const line = buffered.slice(0, index).replace(/\r$/, "");
            buffered = buffered.slice(index + 1);
            for (const listener of [...lineListeners]) listener(line);
            index = buffered.indexOf("\n");
        }
    });

    // stderr is drained but not parsed. Leaving it unread would eventually block the child on a
    // full pipe, which presents as a wedged session.
    child.stderr?.resume();

    const notifyExit = (reason: string) => {
        for (const listener of [...exitListeners]) listener(reason);
    };
    child.once("exit", () => notifyExit("hyper-v-windows-session-exited"));
    child.once("error", () => notifyExit("hyper-v-windows-session-spawn-failed"));
    // Without this, a write to a closed stdin raises an unhandled EPIPE and takes the broker down
    // instead of failing the one call that raced the exit.
    child.stdin?.on("error", () => notifyExit("hyper-v-windows-session-stdin-failed"));

    return {
        write: (line) => { child.stdin?.write(`${line}\n`); },
        onLine: (listener) => { lineListeners.push(listener); },
        onExit: (listener) => { exitListeners.push(listener); },
        kill: () => {
            try {
                child.stdin?.end();
            } finally {
                child.kill();
            }
        },
    };
}

export function brokerHyperVWindowsSession(executable: string): HyperVWindowsSession {
    const existing = sessions.get(executable);
    if (existing) return existing;
    const session = createHyperVWindowsPowerShellSession({
        spawn: (bootstrap) => sessionProcess(executable, bootstrap),
    });
    sessions.set(executable, session);
    return session;
}

// A long-lived child holds a loaded Hyper-V module and a host handle, so leaking one is worse than
// paying the startup cost again. Wired to the broker server's close event.
export function closeBrokerHyperVWindowsSessions(): void {
    const open = [...sessions.values()];
    sessions.clear();
    for (const session of open) {
        try {
            session.close();
        } catch {
            // Closing an already-dead session is not a failure worth surfacing during shutdown.
        }
    }
}

export function brokerHyperVWindowsSessionCountForTest(): number {
    return sessions.size;
}
