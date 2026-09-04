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
const CLOSE_GRACE_MILLISECONDS = 250;

// The three death events this decision is made from, plus the grace timer that stands in for a
// `close` that never came. Not "the ways a child's death reaches us" — there are two more of those,
// the stdin handler and the write callback, and both bypass this decision on purpose. Named rather
// than inlined so the decision below is one function over an enumerated input instead of branches
// spread across handlers, each reachable only by spawning a real process.
//
// Write failures are deliberately NOT in this enum, and two earlier revisions of this comment
// overclaimed what that buys. The first said the absence was itself a safeguard, while a
// `"stdin-error"` member existed and the stdin handler fed it straight to the classifier. The second
// said removing that member made routing a write failure here a compile error. It does not: the
// stdin handler could pass `"error"` — the name the stream event actually has, and the literal used
// by the sibling `child.once("error", ...)` line — and it would compile and return a never-ran for a
// child that had already reached its read loop.
//
// So state it accurately: this enum is a list, and it constrains spelling, not routing. What keeps
// write failures out of this decision is that they are decided elsewhere — by the `settled` protocol
// in `write` below and WRITE_PATH_ERRORS in the session. That is the load-bearing mechanism, and the
// pool test "lets the write path, not the death classifier, decide a failed write" is what pins it.
// The list is the type, not a copy of it. The table test enumerates this array, so an event added
// here is covered by the table automatically, and one cannot be added to the type without appearing
// in the array — they are the same object. (A separate `Event[]` list in the test would have been
// free to fall behind: nothing typechecks `src/__tests__`, so a stale copy there fails nothing.)
export const HYPER_V_WINDOWS_CHILD_DEATH_EVENTS = ["close", "exit", "exit-grace", "error"] as const;

export type HyperVWindowsChildDeathEvent = typeof HYPER_V_WINDOWS_CHILD_DEATH_EVENTS[number];

export type HyperVWindowsChildDeathState = {
    // The child emitted its ready marker, or a reply. Either proves it reached the read loop.
    readonly announcedReady: boolean;
    // Output was discarded unread, so the marker may have been in it.
    readonly latchEvidenceLost: boolean;
    // The child has a pid, which Node assigns only on a successful spawn. See the call site: it is
    // read from the child at death time, not latched by an event.
    readonly spawned: boolean;
};

/**
 * The single place that decides whether a dead child's outstanding request may be re-issued.
 *
 * This exists as one pure function because the decision used to live in five handlers, and twelve
 * rounds of review showed that shape could not be held in one reader's head: guards accumulated
 * until two of them covered the same property, a test written for one silently began passing
 * because of the other, and the invariant it named could be deleted with everything still green.
 * Every rule below is exercised by a table test rather than by spawning children, which is what
 * makes them individually pinned instead of collectively plausible.
 *
 * `start-failed` and `spawn-failed` are in the adapter's never-ran set: returning either tells the
 * broker the request certainly did not run, and it will re-issue it. A wrong never-ran is a second
 * Remove-VMSnapshot against a live host, so every rule here is biased toward `exited`, which is not
 * retryable.
 */
export function hyperVWindowsChildDeathCode(
    event: HyperVWindowsChildDeathEvent,
    state: HyperVWindowsChildDeathState,
): string {
    // A child that never came up cannot have run anything, whichever event carried the news. The
    // caller derives `spawned` from the child's pid, which Node assigns synchronously on a successful
    // spawn and never on a failed one, so this holds by construction rather than by the order the
    // death events happen to arrive in. (`exit-grace` with `!spawned` is unreachable, since the grace
    // only arms from `exit`.)
    if (!state.spawned) return "hyper-v-windows-session-spawn-failed";

    // The grace timer means `close` never arrived, so stdio has not drained and the latch may simply
    // be stale rather than false. That is not evidence the child never ran.
    if (event === "exit-grace") return "hyper-v-windows-session-exited";

    // A post-spawn "error" carries no drain guarantee — unlike `close`, which fires only after stdio
    // drains, and unlike `exit`, which arms the grace timer for exactly that reason. So the latch may
    // be stale here for the same reason it was on the stdin path, and this was the last route left
    // from a stale latch to a never-ran verdict.
    //
    // It is unreachable today: Node emits "error" after a successful spawn only for a kill or IPC
    // failure, every kill() here runs after the session has already nulled its own reference, and the
    // session's identity guard drops the report. But "no caller currently reaches it" is precisely
    // the argument that was made for the spawn-event ordering and for the write-callback ordering,
    // and both turned out to be false — the second one at roughly one run in five. Closing it costs
    // nothing: a genuine spawn failure has no pid and has already returned above.
    if (event === "error") return "hyper-v-windows-session-exited";

    // Output was dropped unread, so the marker may have been inside it. Lost evidence is not proof.
    if (state.latchEvidenceLost) return "hyper-v-windows-session-exited";

    // The child announced itself, which means it reached the loop that reads requests, which means
    // whatever it was sent may have executed.
    if (state.announcedReady) return "hyper-v-windows-session-exited";

    // Nothing announced, nothing lost: the child died before reaching its read loop, so nothing sent
    // to it can have run. This is the one branch that lets the broker retry, and it is why the
    // crash-on-start case falls back to the one-shot transport instead of failing outright.
    return "hyper-v-windows-session-start-failed";
}

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

    const notifyExit = (reason: string) => {
        for (const listener of [...exitListeners]) listener(reason);
    };
    let reportedGone = false;
    const reportGone = (reason: string) => {
        // At most once. Several of these events fire for the same death, and the first is the one
        // with the freshest evidence.
        if (reportedGone) return;
        reportedGone = true;
        notifyExit(reason);
    };
    const report = (event: HyperVWindowsChildDeathEvent) => reportGone(hyperVWindowsChildDeathCode(event, {
        announcedReady,
        latchEvidenceLost,
        // Read from the child rather than latched by a "spawn" listener. Node assigns `pid`
        // synchronously inside spawn() on success and leaves it undefined on failure, before any
        // event fires, and it survives exit and kill() — so this cannot be stale, cannot be missed by
        // a listener registered a tick late, and needs no invariant of its own. Measured in both
        // directions: undefined immediately after spawning a nonexistent binary; a pid immediately
        // after spawning a real one, unchanged through spawn, exit, close and kill().
        spawned: child.pid !== undefined,
    }));

    child.once("close", () => report("close"));
    child.once("exit", () => {
        // `close` is the event that guarantees the latch is fresh, so it is preferred — but it fires
        // only after stdio drains, and a grandchild inheriting the child's stdout keeps it open
        // indefinitely. Measured: with a grandchild holding stdout, `exit` lands immediately and
        // `close` never arrives, so waiting for `close` alone means the death is never reported and
        // the shared pipe is held until the health floor expires with a non-retryable code.
        //
        // So `exit` reports immediately only when the latch is already set — it is monotone, so
        // nothing can be lost by acting early — and otherwise waits briefly for `close`. Whichever
        // arrives first wins, and reportGone makes the second a no-op.
        if (announcedReady || latchEvidenceLost) {
            report("exit");
            return;
        }
        const grace = setTimeout(() => report("exit-grace"), CLOSE_GRACE_MILLISECONDS);
        if (typeof grace === "object" && grace && "unref" in grace) grace.unref();
    });
    child.once("error", () => report("error"));
    // Without this, a write to a closed stdin raises an unhandled EPIPE and takes the broker down
    // instead of failing the one call that raced the exit.
    //
    // It reports a fixed `exited` rather than classifying. A stream "error" can arrive AFTER the
    // child has written output we have not yet read, so the latch is provably stale here — measured:
    // the stdin error fires with announcedReady false, and the child's marker lands after it. Routing
    // it through the classifier returned `start-failed`, a never-ran verdict on a child that had
    // reached its read loop.
    //
    // It was believed that Node's write callback always preempts the stream error, leaving that
    // unreachable. It does not. Measured on the pool test's own stub, roughly one run in five takes
    // the other order and reaches this handler first — so with the classifier wired in, the false
    // never-ran was live at that rate, not merely latent. Ordering here is not a guarantee to build
    // on, which is the same lesson as the `!spawned` check above.
    //
    // The write callback below is the sound discriminator for this path; this handler only needs to
    // report the death, and `exited` is the direction that costs a fallback rather than duplicating
    // a mutation.
    child.stdin?.on("error", () => reportGone("hyper-v-windows-session-exited"));

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
