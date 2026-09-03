import { spawn } from "child_process";

import {
    createHyperVWindowsPowerShellSession,
    HYPER_V_WINDOWS_SESSION_READY_MARKER,
    HYPER_V_WINDOWS_SESSION_RESPONSE_PREFIX,
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

    // Whether this child announced itself. It is what separates "never consumed the request" from
    // "consumed it and then died": the bootstrap emits and flushes this marker immediately BEFORE
    // the loop that reads frames, so a child that has not announced cannot have reached that loop,
    // and therefore cannot have executed anything sent to it.
    //
    // Latching on ANY byte was the earlier version and is weaker in both directions: a child that
    // writes a startup banner and dies without ever reaching the loop counts as having spoken, so
    // its request is not re-issued when it safely could be. The marker is the exact question.
    //
    // The soundness depends on HYPER_V_WINDOWS_SESSION_BOOTSTRAP emitting and flushing the marker
    // before that loop. That is a coupling across two files, so it is pinned by a test — "announces
    // itself before its read loop" in hyper-v-windows-session.test.ts. Do not reorder it.
    //
    // This is NOT the unsound version of the same idea. That one gates on the marker reaching the
    // SESSION's line listener, which is attached later, inside ensureChild, so the marker can be
    // emitted first and lost — and concluding "never announced" from a lost marker moves a request
    // toward being retried. This handler is attached synchronously at spawn, before any byte can
    // arrive, so it cannot miss it.
    let announcedReady = false;
    // Set when output was discarded unread. The latch reads absence of evidence as proof that
    // nothing ran, which is the one place in this slice where the default is the unsafe one — so
    // anything that destroys evidence has to force the conservative answer instead.
    let latchEvidenceLost = false;

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
        buffered += chunk;
        // A child that never emits a newline must not grow this without bound. Dropping the buffer
        // makes the pending request time out, which discards the session, rather than consuming
        // memory until the broker dies.
        if (Buffer.byteLength(buffered, "utf8") > MAX_LINE_BYTES) {
            // Dropping the buffer also drops any evidence it held. The latch defaults to the unsafe
            // answer, so silently losing the marker here would classify this child's requests
            // never-ran for the rest of its life. Treat lost evidence as "cannot prove it never ran".
            latchEvidenceLost = true;
            buffered = "";
            return;
        }
        let index = buffered.indexOf("\n");
        while (index >= 0) {
            const line = buffered.slice(0, index).replace(/\r$/, "");
            buffered = buffered.slice(index + 1);
            // endsWith after trim, not equality. trim() covers U+FEFF — a BOM on the first write is
            // real under some console encodings — and endsWith covers anything else printed ahead of
            // the marker on its line. The loosening costs nothing: response frames start with their
            // own prefix and continue in base64, so no other protocol line ends with this constant.
            // A response frame counts too, and proves the read loop at least as strongly as the
            // marker does, at no cost in reach — a child dying before the loop emits neither.
            if (line.trim().endsWith(HYPER_V_WINDOWS_SESSION_READY_MARKER)
                || line.startsWith(HYPER_V_WINDOWS_SESSION_RESPONSE_PREFIX)) {
                announcedReady = true;
            }
            for (const listener of [...lineListeners]) listener(line);
            index = buffered.indexOf("\n");
        }
    });

    // stderr is drained but not parsed. Leaving it unread would eventually block the child on a
    // full pipe, which presents as a wedged session. It cannot carry the marker, so it says nothing
    // about whether the read loop was reached.
    child.stderr?.resume();

    // A child that never announced never reached its read loop, so nothing sent to it can have run.
    // start-failed already carries exactly that meaning and is already treated as never-ran.
    //
    // Driven from `close`, not `exit`. Node may still have stdio open at `exit`, so a marker
    // emitted but not yet delivered would read false and produce exactly the false never-ran this
    // exists to avoid; `close` fires only after the streams drain, which closes that by
    // construction rather than by scheduling luck. Measured 112/112 the safe way at `exit` too, but
    // that was libuv ordering, not a guarantee.
    //
    // Only for the paths that report the child GOING AWAY. It must not be consulted from a write
    // completion, which fires before any of the child's own output can be delivered to this process
    // — there the latch reads false even for a child that has already announced, which would call an
    // executed request never-ran and have the broker re-issue it. Measured 3/40 before this split.
    const exitReason = (reason: string) => (
        announcedReady || latchEvidenceLost ? reason : "hyper-v-windows-session-start-failed"
    );

    const notifyExit = (reason: string) => {
        for (const listener of [...exitListeners]) listener(reason);
    };
    // Both events, because neither alone is correct. `close` is the one that guarantees the latch is
    // fresh, since it fires only after stdio drains — but it fires only after stdio drains, and a
    // grandchild inheriting the child's stdout keeps it open indefinitely. Measured: with a
    // grandchild holding stdout, `exit` lands immediately and `close` never arrives, so listening to
    // `close` alone means the death is never reported and the shared pipe is held until the health
    // floor expires with a code that is not retryable.
    //
    // `exit` alone is what this replaced, and it can read a marker that has not been delivered yet.
    // So: if the latch is already set, `exit` may report at once — the latch is monotone, so nothing
    // can be lost by acting early. If it is not, wait briefly for `close`, and if it does not come,
    // report the conservative answer rather than the never-ran one. `close` wins whenever it arrives.
    const CLOSE_GRACE_MILLISECONDS = 250;
    let reportedGone = false;
    const reportGone = (reason: string) => {
        if (reportedGone) return;
        reportedGone = true;
        notifyExit(reason);
    };
    child.once("close", () => reportGone(exitReason("hyper-v-windows-session-exited")));
    child.once("exit", () => {
        if (announcedReady || latchEvidenceLost) {
            reportGone("hyper-v-windows-session-exited");
            return;
        }
        const grace = setTimeout(() => {
            // Never `start-failed` from here: the latch is only unset because nothing has been
            // delivered yet, which is not evidence that nothing ran.
            reportGone("hyper-v-windows-session-exited");
        }, CLOSE_GRACE_MILLISECONDS);
        if (typeof grace === "object" && grace && "unref" in grace) grace.unref();
    });
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
    child.stdin?.on("error", () => reportGone(exitReason("hyper-v-windows-session-exited")));

    return {
        write: (line, settled) => {
            child.stdin?.write(`${line}\n`, (error) => {
                // Ordered deliberately: the session marks the request undelivered from `settled`,
                // and only then is the failure raised — so failAll always reads the corrected flag.
                // A PowerShell that spawned and died before this write is the case that depends on
                // it: nothing reached the pipe, so re-issuing it one-shot cannot duplicate a
                // mutation, and without this it failed outright on every attempt.
                settled?.(error ?? undefined);
                // Raised bare, NOT through exitReason: this fires before the child's own output can
                // reach us, so the latch would read false here regardless of what the child did. The
                // `settled` report above is the sound discriminator on this path, and the session
                // decides from it.
                if (error) notifyExit("hyper-v-windows-session-stdin-failed");
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
