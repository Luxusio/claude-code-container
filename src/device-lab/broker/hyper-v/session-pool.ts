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

    // Whether this child has ever produced a byte. It is the only signal measured to separate
    // "never consumed the request" from "consumed it and then died", deterministically: the
    // bootstrap announces itself before entering its read loop, so a child that has produced NOTHING
    // cannot have reached that loop, and therefore cannot have executed anything sent to it.
    //
    // The write completion callback looked like it answered this and does not. It reports whether
    // the bytes left this process, and a write into a pipe succeeds into the kernel buffer whether
    // or not anyone will ever read it — so for a PowerShell that spawns and dies, the frame lands in
    // a buffer belonging to a dead reader and the callback reports success. Measured, it identified
    // the case 2/30 where this latch identifies it 30/30.
    //
    // The soundness depends on HYPER_V_WINDOWS_SESSION_BOOTSTRAP emitting and flushing its ready
    // marker BEFORE the loop that reads frames. That is a coupling across two files, so it is pinned
    // by a test — "announces itself before its read loop" in hyper-v-windows-session.test.ts. Do not
    // reorder those statements without reading it.
    //
    // This is NOT a gate on the READY marker reaching the session's line listener; that is unsound,
    // because the marker can be emitted before the listener attaches and then be lost, which would
    // move a request toward being retried. This handler is attached synchronously at spawn, before
    // any byte can arrive, and it does not care what the output was — only that there was some.
    let producedOutput = false;

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
        producedOutput = true;
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
    // full pipe, which presents as a wedged session. Deliberately NOT counted toward the latch: the
    // proof is entirely about the READY marker on stdout, so stderr adds nothing to it and costs
    // reach — a PowerShell that writes a startup diagnostic to stderr and then dies is exactly the
    // population the latch exists to catch, and counting stderr would classify it as having spoken.
    child.stderr?.resume();

    // A child that never spoke never reached its read loop, so nothing sent to it can have run.
    // start-failed already carries exactly that meaning and is already treated as never-ran.
    const exitReason = (reason: string) => (producedOutput ? reason : "hyper-v-windows-session-start-failed");

    const notifyExit = (reason: string) => {
        for (const listener of [...exitListeners]) listener(reason);
    };
    child.once("exit", () => notifyExit(exitReason("hyper-v-windows-session-exited")));
    // "error" means the process could not be spawned only until it has spawned; Node also emits it
    // when a live child cannot be killed or is aborted by signal. spawn-failed is in the adapter's
    // never-ran set, so reporting a live child's error under that name would tell the broker a
    // request that may already have run Remove-VMSnapshot is safe to re-issue. Node emits "spawn"
    // only on a successful spawn, and emits "error" instead of it when the spawn fails, so the flag
    // cannot be set by a child that never came up. After it, any error is reported as an exit.
    let spawned = false;
    child.once("spawn", () => { spawned = true; });
    child.once("error", () => notifyExit(
        spawned ? exitReason("hyper-v-windows-session-exited") : "hyper-v-windows-session-spawn-failed",
    ));
    // Without this, a write to a closed stdin raises an unhandled EPIPE and takes the broker down
    // instead of failing the one call that raced the exit. Reported as an exit rather than a write
    // failure: by the time a stream-level error arrives on its own, any write we issued has already
    // reported its own outcome through the callback below, which is the signal that actually knows.
    child.stdin?.on("error", () => notifyExit(exitReason("hyper-v-windows-session-exited")));

    return {
        write: (line, settled) => {
            child.stdin?.write(`${line}\n`, (error) => {
                // Ordered deliberately: the session marks the request undelivered from `settled`,
                // and only then is the failure raised — so failAll always reads the corrected flag.
                // A PowerShell that spawned and died before this write is the case that depends on
                // it: nothing reached the pipe, so re-issuing it one-shot cannot duplicate a
                // mutation, and without this it failed outright on every attempt.
                settled?.(error ?? undefined);
                if (error) notifyExit(exitReason("hyper-v-windows-session-stdin-failed"));
            });
        },
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

// A long-lived child holds a loaded Hyper-V module and a host handle, so leaking one is worse than
// paying the startup cost again. Reference counted because the map is module scoped while broker
// servers are not: a process can hold more than one, and a session carries no per-server state, so
// they share. Closing on the first server's close event would kill a child another server is
// mid-request on, and hyper-v-windows-session-closed is deliberately not a retryable error — that
// request would fail outright rather than fall back.
let holders = 0;
let closedPoolSession: HyperVWindowsSession | null = null;

export function brokerHyperVWindowsSession(executable: string): HyperVWindowsSession {
    if (holders === 0) {
        // No broker is left to close what this would spawn. Sessions are handed out lazily from
        // inside async tool handlers, so a request still in flight past the last server's close
        // would otherwise start a child nothing ever kills. This one reports itself unavailable,
        // which the adapter treats as never-ran and serves through the one-shot transport — the way
        // the broker served every primitive before sessions existed.
        // One shared instance: each execute on it verifies the pinned asset first, which reads and
        // hashes the file, and there is no reason to pay that per straggler request.
        closedPoolSession ??= createHyperVWindowsPowerShellSession({
            spawn: () => {
                throw new Error("hyper-v-windows-session-pool-closed");
            },
        });
        return closedPoolSession;
    }
    const existing = sessions.get(executable);
    if (existing) return existing;
    const session = createHyperVWindowsPowerShellSession({
        spawn: (bootstrap) => sessionProcess(executable, bootstrap),
    });
    sessions.set(executable, session);
    installProcessExitSweep();
    return session;
}

// Node does not kill a child when the parent exits, on any platform. Every path that closes the pool
// runs off a broker server's close event, and a server that is constructed and never closed pins the
// reference count above zero — at which point nothing else can ever release it either. This sweep
// does not depend on how the count got stuck: whatever is still pooled when the process exits gets
// killed, so a long-lived PowerShell child holding a loaded Hyper-V module cannot outlive the broker
// that started it. Installed lazily so a process that never uses Hyper-V never registers a listener.
//
// What it does not cover: "exit" does not fire on SIGINT or SIGTERM unless something calls
// process.exit, nor on a fatal signal. A broker killed outright by a service manager therefore still
// leaves its children behind. The broker's own signal handling is what closes that gap; this is the
// backstop for the ordinary exits.
let exitSweepInstalled = false;

function installProcessExitSweep(): void {
    if (exitSweepInstalled) return;
    exitSweepInstalled = true;
    process.once("exit", () => {
        for (const session of sessions.values()) {
            try {
                session.close();
            } catch {
                // Nothing useful can be reported from an exit handler.
            }
        }
        sessions.clear();
    });
}

// Wired to the broker server's close event.
export function retainBrokerHyperVWindowsSessions(): () => void {
    // A broker exists again, so the closed-pool instance handed to stragglers is stale. Keeping it
    // would carry an exhausted start budget into the next broker's lifetime.
    if (holders === 0) closedPoolSession = null;
    holders += 1;
    let released = false;
    return () => {
        if (released) return;
        released = true;
        holders -= 1;
        if (holders > 0) return;
        const open = [...sessions.values()];
        sessions.clear();
        for (const session of open) {
            try {
                session.close();
            } catch {
                // Closing an already-dead session is not a failure worth surfacing during shutdown.
            }
        }
    };
}

export function brokerHyperVWindowsSessionCountForTest(): number {
    return sessions.size;
}
