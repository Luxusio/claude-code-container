import {
    verifiedOperationAsset,
    type HyperVWindowsPowerShellOperationAsset,
} from "./powershell-transport.js";
import type {
    HyperVWindowsExecutionContext,
    HyperVWindowsExecutionRequest,
    HyperVWindowsExecutionResult,
    HyperVWindowsExecutor,
} from "./contracts.js";

// One framed request and one framed response per line, Base64 of UTF-8 JSON. Base64 is what keeps a
// frame free of newlines without escaping rules, and line framing is what lets the reader resolve a
// response without knowing the payload length in advance.
export const HYPER_V_WINDOWS_SESSION_REQUEST_PREFIX = "CCC_HYPER_V_SESSION_REQUEST:";
export const HYPER_V_WINDOWS_SESSION_RESPONSE_PREFIX = "CCC_HYPER_V_SESSION_RESPONSE:";
export const HYPER_V_WINDOWS_SESSION_READY_MARKER = "CCC_HYPER_V_SESSION_READY";

const MAX_FRAME_BYTES = 256 * 1024;
const MAX_REQUEST_BYTES = 64 * 1024;
const DEFAULT_MAX_STARTS = 3;
// How long a request may sit unanswered before the child is declared wedged, independent of what
// any one caller's deadline was. Matched to the library's per-execution ceiling, so an operation
// slow enough to trip this would have timed out through the one-shot transport too.
const DEFAULT_HEALTH_TIMEOUT_MILLISECONDS = 120 * 1000;
// How long an unproductive start stays on the record. The budget is meant to catch "this host
// cannot run PowerShell", which presents as failures in quick succession; without expiry it is an
// absorbing state — once the cap is reached no start is attempted, so no answer can ever arrive to
// reset it, and three stalls spread across days demote a healthy broker to one-shot permanently.
const DEFAULT_START_BUDGET_WINDOW_MILLISECONDS = 5 * 60 * 1000;
// How much of a caller's own budget the queue may consume before the caller is told its request
// never ran and is served in its own process instead. A quarter leaves three quarters for that
// retry, which is the whole point: a fallback the caller has no time left to use is not a fallback.
const DEFAULT_QUEUE_WAIT_FRACTION = 0.25;
// Beyond this many waiting callers the pipe is not worth queueing for. Refusing immediately is what
// keeps one owner's slow operation from consuming every other owner's deadline, and it is also what
// bounds the memory the queue holds — each waiting closure pins its request.
const DEFAULT_MAXIMUM_QUEUE_DEPTH = 8;

// The child reads the asset source once, then serves requests from stdin until the stream closes.
// The asset is still one-operation-per-invocation: the loop lives here, and each iteration
// re-invokes it with a fresh $global:CccHyperVJsonInput. That is deliberate — the pinned asset
// stays the same artifact the one-shot transport verifies, so both paths execute byte-identical
// operation code and cannot diverge.
export const HYPER_V_WINDOWS_SESSION_BOOTSTRAP = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    // The asset source arrives once, on the first line, so it never has to be re-sent or re-read
    // from disk while the session runs.
    "$ScriptSource = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine()))",
    "$Operation = [ScriptBlock]::Create($ScriptSource)",
    // Emitted and flushed BEFORE the loop below, deliberately. The broker treats a child that
    // produced no stdout as never having run anything and re-issues those requests, so a child that
    // could consume a frame without speaking first would have executed mutations re-applied. Pinned
    // by "announces itself before its read loop" in the session tests; do not reorder these.
    `[Console]::Out.WriteLine('${HYPER_V_WINDOWS_SESSION_READY_MARKER}')`,
    "[Console]::Out.Flush()",
    "while ($true) {",
    "  $Line = [Console]::In.ReadLine()",
    "  if ($null -eq $Line) { break }",
    `  if (-not $Line.StartsWith('${HYPER_V_WINDOWS_SESSION_REQUEST_PREFIX}')) { continue }`,
    `  $Frame = $Line.Substring(${HYPER_V_WINDOWS_SESSION_REQUEST_PREFIX.length})`,
    "  $Envelope = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Frame)) | ConvertFrom-Json",
    "  $global:CccHyperVJsonInput = [string]$Envelope.input",
    // Each operation runs in its own child scope, so one failure cannot leave state behind for the
    // next request. The asset opens by resetting $global:CccHyperVExitCode, so the value read back
    // below always belongs to the invocation that just ran.
    "  $Captured = ''",
    "  $Code = 0",
    // Joined rather than piped through Out-String: the reply is a single compact JSON line that the
    // reader parses, and Out-String formats to a width, which is free to insert line breaks into a
    // long envelope. 2>&1 is likewise gone — merging the error stream into machine-readable output
    // corrupts it, and the session owner drains stderr separately.
    "  try { $Captured = [string]::Join([string][char]10, @(& $Operation)); $Code = [int]$global:CccHyperVExitCode }"
        + " catch { $Captured = ''; $Code = 1 }",
    // One child now serves every owner, where a process boundary used to reset all of this between
    // them. The asset's allowlist admits only fixed Hyper-V cmdlets with typed arguments, so nothing
    // today can set these — but $PSDefaultParameterValues silently re-aims the pinned asset's calls
    // for every later owner without changing a byte of the hashed asset (Remove-VMSnapshot's
    // -IncludeAllChildSnapshots is the obvious one), and the input holds the previous owner's VM and
    // snapshot names. Clearing both per iteration costs nothing and keeps the property the process
    // boundary used to give for free.
    "  $global:CccHyperVJsonInput = ''",
    "  $global:PSDefaultParameterValues = @{}",
    "  $Reply = [ordered]@{ id = [string]$Envelope.id; code = $Code; stdout = [string]$Captured }",
    "  $Payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($Reply | ConvertTo-Json -Compress -Depth 4)))",
    `  [Console]::Out.WriteLine('${HYPER_V_WINDOWS_SESSION_RESPONSE_PREFIX}' + $Payload)`,
    "  [Console]::Out.Flush()",
    "}",
].join("; ");

export type HyperVWindowsSessionProcess = {
    // `settled` reports whether the line actually reached the pipe. It is the only signal that can
    // separate a child that never received the request at all from one that received it and then
    // died — the difference between safe to re-issue and a second Remove-VMSnapshot. A write()
    // return cannot separate them: writing to an already-dead child does not throw, it returns
    // normally and reports ERR_STREAM_DESTROYED asynchronously. An implementation that never calls
    // `settled` is treated as having delivered, because that is the conservative reading.
    readonly write: (line: string, settled?: (error?: unknown) => void) => void;
    readonly onLine: (listener: (line: string) => void) => void;
    readonly onExit: (listener: (reason: string) => void) => void;
    readonly kill: () => void;
};

export type HyperVWindowsSessionSpawn = (
    bootstrap: string,
) => HyperVWindowsSessionProcess | Promise<HyperVWindowsSessionProcess>;

export type HyperVWindowsSessionOptions = {
    readonly spawn: HyperVWindowsSessionSpawn;
    readonly operationAsset?: HyperVWindowsPowerShellOperationAsset;
    // Bounded so a host that cannot start PowerShell fails fast instead of respawning forever.
    readonly maximumStarts?: number;
    // How long a request may go unanswered before the child is torn down. Deliberately separate from
    // the caller's deadline: see the two timers in send().
    readonly healthTimeoutMilliseconds?: number;
    // How long an unproductive start counts against the budget above.
    readonly startBudgetWindowMilliseconds?: number;
    // Admission control: the share of a caller's budget the queue may consume, and how many callers
    // may wait at all. See execute().
    readonly queueWaitFraction?: number;
    readonly maximumQueueDepth?: number;
};

export type HyperVWindowsSession = HyperVWindowsExecutor & {
    close(): void;
    // Observability for the invariant that matters: one process serving many primitives.
    starts(): number;
};

type Pending = {
    readonly resolve: (result: HyperVWindowsExecutionResult) => void;
    // Cancels both of this request's timers. A request outlives its caller — the caller's deadline
    // settles the call, but the entry stays until the child answers or the health floor declares the
    // child wedged — so the entry, not the caller, owns the timers.
    readonly clear: () => void;
    // Whether this request's frame was handed to the child without the write throwing. It is what
    // lets the never-ran classification be checked rather than trusted: see failAll.
    delivered: boolean;
};

function frameError(code: string): HyperVWindowsExecutionResult {
    // Shaped like a failed one-shot execution rather than thrown, so the client's existing
    // transport classification applies unchanged and no new error path reaches callers.
    return { status: null, stdout: "", error: code };
}

export function createHyperVWindowsPowerShellSession(
    options: HyperVWindowsSessionOptions,
): HyperVWindowsSession {
    const maximumStarts = Math.max(1, Math.trunc(options.maximumStarts ?? DEFAULT_MAX_STARTS));
    const healthTimeoutMilliseconds = Math.max(
        1,
        Math.trunc(options.healthTimeoutMilliseconds ?? DEFAULT_HEALTH_TIMEOUT_MILLISECONDS),
    );
    const startBudgetWindowMilliseconds = Math.max(
        1,
        Math.trunc(options.startBudgetWindowMilliseconds ?? DEFAULT_START_BUDGET_WINDOW_MILLISECONDS),
    );
    // Floored rather than clamped to [0, 1]: a fraction of 0 gives every caller a 1ms queue wait,
    // which silently turns the session off under any contention. The knob should not be able to
    // disable the thing it tunes.
    // Number.isFinite first: NaN defeats both clamps below — Math.max(0.05, NaN) is NaN, giving
    // every caller a 1ms queue wait, and `depth >= NaN` is always false, disabling the cap. Those
    // are exactly the two states the clamps exist to prevent.
    const queueWaitFraction = Number.isFinite(options.queueWaitFraction)
        ? Math.min(1, Math.max(0.05, options.queueWaitFraction as number))
        : DEFAULT_QUEUE_WAIT_FRACTION;
    const maximumQueueDepth = Number.isFinite(options.maximumQueueDepth)
        ? Math.max(1, Math.trunc(options.maximumQueueDepth as number))
        : DEFAULT_MAXIMUM_QUEUE_DEPTH;
    let queueDepth = 0;
    const pending = new Map<string, Pending>();
    let child: HyperVWindowsSessionProcess | null = null;
    let starting: Promise<HyperVWindowsSessionProcess | null> | null = null;
    // Two counters, because they answer two different questions. starts is the lifetime total and
    // exists only so a caller can prove one process served many primitives. unansweredStarts is the
    // budget, and it counts starts that have not yet produced an answer — the condition the budget
    // is for is "this host cannot run PowerShell", not "this broker has been up for days".
    let starts = 0;
    let unansweredStarts = 0;
    let lastUnproductiveStartAt = 0;
    let closed = false;
    let sequence = 0;

    // Codes whose whole meaning is "this request's frame never reached the child" — which is what
    // puts them in the adapter's never-ran set and makes the broker re-issue them. They are raised
    // by the process implementation, so taking them at face value would make the safety of a
    // duplicate Remove-VMSnapshot a contract on that implementation rather than something anything
    // checks. If the write for this entry already returned, the frame may have been delivered, and
    // the entry is failed as an exit instead — which is not retryable.
    const WRITE_PATH_ERRORS = new Set([
        "hyper-v-windows-session-stdin-failed",
        "hyper-v-windows-session-write-failed",
    ]);

    function failAll(code: string) {
        const outstanding = [...pending.values()];
        pending.clear();
        for (const entry of outstanding) {
            entry.clear();
            const reported = entry.delivered && WRITE_PATH_ERRORS.has(code)
                ? "hyper-v-windows-session-exited"
                : code;
            entry.resolve(frameError(reported));
        }
    }

    function discard(code: string) {
        const previous = child;
        child = null;
        starting = null;
        if (previous) {
            try {
                previous.kill();
            } catch {
                // Killing an already-dead child is not a failure worth surfacing.
            }
        }
        failAll(code);
    }

    function handleLine(line: string) {
        // Anything that is not a response frame — the ready marker, or stray child output — is
        // ignored. The marker is deliberately NOT a readiness gate: gating on it made the session
        // unusable whenever the child announced itself before the line listener was attached, since
        // the marker was lost and every later call then spawned another process. A request written
        // before the child starts reading simply waits in the pipe, which is what pipes are for.
        if (!line.startsWith(HYPER_V_WINDOWS_SESSION_RESPONSE_PREFIX)) return;
        const frame = line.slice(HYPER_V_WINDOWS_SESSION_RESPONSE_PREFIX.length);
        if (Buffer.byteLength(frame, "utf8") > MAX_FRAME_BYTES) {
            discard("hyper-v-windows-session-response-too-large");
            return;
        }
        let reply: { id?: unknown; code?: unknown; stdout?: unknown };
        try {
            reply = JSON.parse(Buffer.from(frame, "base64").toString("utf8"));
        } catch {
            discard("hyper-v-windows-session-response-invalid");
            return;
        }
        if (!Number.isInteger(reply.code) || typeof reply.stdout !== "string") {
            // A frame missing its exit code is not a success with an unknown status, it is a frame
            // this reader does not understand — the same class as unparseable base64.
            discard("hyper-v-windows-session-response-invalid");
            return;
        }
        const id = typeof reply.id === "string" ? reply.id : "";
        const entry = id ? pending.get(id) : undefined;
        if (!entry) {
            // A response nobody is waiting for means the stream and the caller set have diverged.
            // Pairing it with whatever happens to be pending would return one call's result to
            // another, so the session is torn down instead.
            discard("hyper-v-windows-session-response-uncorrelated");
            return;
        }
        pending.delete(id);
        entry.clear();
        // A session that answers is a session that started, so the budget below bounds consecutive
        // unproductive starts rather than the lifetime of the broker that owns them.
        unansweredStarts = 0;
        // The asset reports a native failure as exit code 1, and the one-shot transport turns that
        // into the process exit status. Carrying it here is what makes the two transports produce
        // identical HyperVWindowsExecutionResults for identical host conditions.
        entry.resolve({ status: reply.code as number, stdout: reply.stdout as string });
    }

    async function ensureChild(): Promise<HyperVWindowsSessionProcess | null> {
        if (closed) return null;
        if (child) return child;
        if (starting) return starting;
        // Expire the record before consulting it. Once the cap is reached no start is attempted, so
        // handleLine can never run to reset the counter — without expiry the budget is an absorbing
        // state and a healthy host stays demoted forever.
        if (Date.now() - lastUnproductiveStartAt > startBudgetWindowMilliseconds) unansweredStarts = 0;
        if (unansweredStarts >= maximumStarts) return null;
        starts += 1;
        unansweredStarts += 1;
        lastUnproductiveStartAt = Date.now();
        starting = (async () => {
            const asset = verifiedOperationAsset(options.operationAsset);
            const spawned = await options.spawn(HYPER_V_WINDOWS_SESSION_BOOTSTRAP);
            if (closed) {
                // close() ran while this spawn was in flight, so it discarded a child that was still
                // null. Adopting one now would leave a live PowerShell process holding a loaded
                // Hyper-V module that nothing owns and nothing will ever kill.
                try {
                    spawned.kill();
                } catch {
                    // Killing a child that never came up is not a failure worth surfacing.
                }
                return null;
            }
            // Adopted before the listeners are attached, so the identity guards below admit this
            // child's own output from the first line.
            child = spawned;
            // Guarded exactly like onExit. Killing a child does not discard what its pipe already
            // delivered, so a frame from a discarded session can still arrive after its replacement
            // is serving. Unguarded, handleLine would find no pending id for it and tear down the
            // healthy child, failing an unrelated in-flight request.
            spawned.onLine((line) => {
                if (child === spawned) handleLine(line);
            });
            spawned.onExit((reason) => {
                if (child === spawned) discard(reason || "hyper-v-windows-session-exited");
            });
            // The asset write reports its outcome too. Its completion fires before any request's,
            // so without this its failure reached failAll while every pending entry still read as
            // delivered, and the never-ran classification was silently lost. Stream ordering makes
            // this sound: if the asset never reached the child, nothing written after it did either.
            spawned.write(Buffer.from(asset.scriptSource, "utf8").toString("base64"), (error) => {
                // Identity guarded like onLine and onExit above, and for the same reason: a callback
                // from a discarded child can still arrive after its replacement is serving. Without
                // it, a stale asset-write failure clears `delivered` on the CURRENT child's pending
                // entry, so a frame that did reach the host is reported never-ran and re-issued —
                // the duplicate mutation. "Every pending entry" is only equivalent to "the one"
                // because of this guard, not because of the serialization invariant.
                if (!error || child !== spawned) return;
                for (const entry of pending.values()) entry.delivered = false;
            });
            return spawned;
        })();
        try {
            return await starting;
        } catch {
            discard("hyper-v-windows-session-start-failed");
            return null;
        } finally {
            starting = null;
        }
    }

    // One stdin and one stdout mean one request at a time. Callers are queued rather than rejected:
    // the adapters issue dependent chains, so a concurrent caller is a different flow, not a bug.
    //
    // The queue is released when the request leaves the pipe, NOT when its caller stops waiting. A
    // caller can give up on its own deadline while the child is still working the request, and
    // writing the next frame into a child that has answered nothing would put two requests on a
    // stream that can only carry one — and would start the next caller's timer against work it has
    // not reached yet, timing it out for someone else's stall.
    let queue: Promise<unknown> = Promise.resolve();

    async function send(
        request: HyperVWindowsExecutionRequest,
        context: HyperVWindowsExecutionContext,
        // Absolute, set when the caller called execute — so time spent queueing counts against the
        // caller's budget rather than being handed back to it at the head of the queue.
        expiresAt: number,
        release: () => void,
    ): Promise<HyperVWindowsExecutionResult> {
        // Either a pending entry takes ownership of the pipe, or this call frees it — structurally,
        // in a finally, rather than by remembering a release() at each exit. Releasing per exit is
        // one forgotten line away from a permanent deadlock: nothing here has a timeout until the
        // frame is built, so a throw before that (JSON.stringify on a circular value, say) would
        // leave every later primitive on a process-wide shared session waiting forever.
        let owned = false;
        try {
            if (context.signal?.aborted) return frameError("hyper-v-windows-session-cancelled");
            const active = await ensureChild();
            if (!active) return frameError("hyper-v-windows-session-unavailable");

            const payload = JSON.stringify(request);
            if (Buffer.byteLength(payload, "utf8") > MAX_REQUEST_BYTES) {
                return frameError("hyper-v-windows-session-request-too-large");
            }
            sequence += 1;
            const id = `r${sequence}`;
            const frame = Buffer.from(JSON.stringify({ id, input: `${payload}\n` }), "utf8").toString("base64");
            if (Buffer.byteLength(frame, "utf8") > MAX_FRAME_BYTES) {
                return frameError("hyper-v-windows-session-request-too-large");
            }

            return await new Promise<HyperVWindowsExecutionResult>((resolve) => {
                let done = false;
                let cleared = false;
                const clear = () => {
                    if (cleared) return;
                    cleared = true;
                    clearTimeout(callerTimer);
                    clearTimeout(healthTimer);
                    // The pipe is free only now — this is what the next caller waits on.
                    release();
                };
                const settle = (result: HyperVWindowsExecutionResult) => {
                    if (done) return;
                    done = true;
                    resolve(result);
                };
                // Two deadlines, because they answer two different questions, and conflating them
                // made a near-expired caller kill a child every other flow was using. The broker
                // bounds each primitive by what is left of its operation deadline, and
                // hyperVRemainingTimeout floors that at 1ms — so "my caller ran out of budget" says
                // nothing about the child's health. The caller's deadline settles the caller and
                // leaves the request pending; if the child later answers, the reply still clears the
                // entry and still counts as a productive session. Only the health floor below
                // concludes the child is wedged.
                const callerTimer = setTimeout(() => {
                    settle(frameError("hyper-v-windows-session-timeout"));
                }, Math.max(1, expiresAt - Date.now()));
                const healthTimer = setTimeout(() => {
                    pending.delete(id);
                    clear();
                    discard("hyper-v-windows-session-timeout");
                    settle(frameError("hyper-v-windows-session-timeout"));
                }, Math.max(1, context.timeoutMilliseconds, healthTimeoutMilliseconds));
                for (const timer of [callerTimer, healthTimer]) {
                    if (typeof timer === "object" && timer && "unref" in timer) timer.unref();
                }
                const entry: Pending = { resolve: settle, clear, delivered: false };
                pending.set(id, entry);
                // From here a timer guarantees the entry is cleared, so the pipe is owned rather than
                // leaked no matter what happens next.
                owned = true;
                try {
                    // Optimistic and then corrected, in that order, because the correction is the
                    // only one that can move a request toward being retried. Returning from write()
                    // proves nothing — a write to a dead child returns normally — so the entry is
                    // treated as delivered until the process reports otherwise. The pool raises the
                    // stdin failure from inside this callback, so the correction always lands before
                    // failAll reads it.
                    entry.delivered = true;
                    active.write(`${HYPER_V_WINDOWS_SESSION_REQUEST_PREFIX}${frame}`, (error) => {
                        if (error) entry.delivered = false;
                    });
                } catch {
                    pending.delete(id);
                    clear();
                    discard("hyper-v-windows-session-write-failed");
                    settle(frameError("hyper-v-windows-session-write-failed"));
                }
            });
        } finally {
            if (!owned) release();
        }
    }

    return {
        execute(request, context) {
            // Admission control, not budget arithmetic. One slow operation holds the single
            // process-wide pipe for up to the health floor, and every other owner queues behind it.
            // The escape is the never-ran classification below, which lets the broker serve a queued
            // caller one-shot — but that only helps if the caller reaches it with budget left to
            // spend. Waiting the whole budget in the queue and then falling back is the same as not
            // falling back; subtracting the wait from the retry is worse, because the retry then
            // gets ~1ms and is guaranteed to fail. So the queue may consume only a fraction of the
            // caller's budget, and a queue already this deep is refused outright: the pipe serves
            // one request at a time, so a caller far back in the line has no realistic chance and is
            // better off in its own process immediately.
            if (queueDepth >= maximumQueueDepth) {
                return Promise.resolve(frameError("hyper-v-windows-session-queue-timeout"));
            }
            queueDepth += 1;

            // Two promises: the caller awaits `run`, the queue awaits `free`. They part company
            // exactly when a caller's deadline expires on a request the child is still working.
            // The depth slot is held for as long as the pipe is — the caller occupying it counts,
            // not just the ones behind it — so the cap describes the real length of the line.
            let holdsSlot = true;
            let resolveFree = () => undefined as void;
            const free = new Promise<void>((resolve) => { resolveFree = resolve; });
            const release = () => {
                if (holdsSlot) {
                    holdsSlot = false;
                    queueDepth -= 1;
                }
                resolveFree();
            };

            // The caller's deadline starts here, not when the request reaches the head of the queue.
            // Timing it from inside send() gave a queued caller no deadline at all: it waited out the
            // health floor, which is exactly the "a primitive with 2.5s of budget must not run
            // against the 120s ceiling" failure the clamp exists to prevent, reappearing one layer up.
            const expiresAt = Date.now() + Math.max(1, context.timeoutMilliseconds);
            let dequeued = false;
            let expiredInQueue = false;
            let expire = (_result: HyperVWindowsExecutionResult) => undefined as void;
            const queueExpiry = new Promise<HyperVWindowsExecutionResult>((resolve) => { expire = resolve; });
            const queueTimer = setTimeout(() => {
                if (dequeued) return;
                expiredInQueue = true;
                expire(frameError("hyper-v-windows-session-queue-timeout"));
            }, Math.max(1, Math.floor(context.timeoutMilliseconds * queueWaitFraction)));
            if (typeof queueTimer === "object" && queueTimer && "unref" in queueTimer) queueTimer.unref();

            const run = queue.then(() => {
                dequeued = true;
                clearTimeout(queueTimer);
                if (expiredInQueue) {
                    // Its frame was never written, so nothing reached the host. That is a distinct
                    // code from a timeout on a request the child actually received, because it is
                    // the one case where re-issuing provably cannot apply a mutation twice.
                    release();
                    return frameError("hyper-v-windows-session-queue-timeout");
                }
                return send(request, context, expiresAt, release);
            });
            queue = run.then(() => free, () => free);
            return Promise.race([queueExpiry, run]);
        },
        close() {
            closed = true;
            discard("hyper-v-windows-session-closed");
        },
        starts() {
            return starts;
        },
    };
}
