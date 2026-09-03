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
    "  $Reply = [ordered]@{ id = [string]$Envelope.id; code = $Code; stdout = [string]$Captured }",
    "  $Payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($Reply | ConvertTo-Json -Compress -Depth 4)))",
    `  [Console]::Out.WriteLine('${HYPER_V_WINDOWS_SESSION_RESPONSE_PREFIX}' + $Payload)`,
    "  [Console]::Out.Flush()",
    "}",
].join("; ");

export type HyperVWindowsSessionProcess = {
    readonly write: (line: string) => void;
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
};

export type HyperVWindowsSession = HyperVWindowsExecutor & {
    close(): void;
    // Observability for the invariant that matters: one process serving many primitives.
    starts(): number;
};

type Pending = {
    readonly resolve: (result: HyperVWindowsExecutionResult) => void;
    readonly settled: () => boolean;
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
    const pending = new Map<string, Pending>();
    let child: HyperVWindowsSessionProcess | null = null;
    let starting: Promise<HyperVWindowsSessionProcess | null> | null = null;
    // Two counters, because they answer two different questions. starts is the lifetime total and
    // exists only so a caller can prove one process served many primitives. unansweredStarts is the
    // budget, and it counts starts that have not yet produced an answer — the condition the budget
    // is for is "this host cannot run PowerShell", not "this broker has been up for days".
    let starts = 0;
    let unansweredStarts = 0;
    let closed = false;
    let sequence = 0;

    function failAll(code: string) {
        const outstanding = [...pending.values()];
        pending.clear();
        for (const entry of outstanding) entry.resolve(frameError(code));
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
        // A session that answers is a session that started, so the budget below bounds consecutive
        // unproductive starts rather than the lifetime of the broker that owns them.
        unansweredStarts = 0;
        // The asset reports a native failure as exit code 1, and the one-shot transport turns that
        // into the process exit status. Carrying it here is what makes the two transports produce
        // identical HyperVWindowsExecutionResults for identical host conditions.
        entry.resolve({
            status: Number.isInteger(reply.code) ? (reply.code as number) : 0,
            stdout: typeof reply.stdout === "string" ? reply.stdout : "",
        });
    }

    async function ensureChild(): Promise<HyperVWindowsSessionProcess | null> {
        if (closed) return null;
        if (child) return child;
        if (starting) return starting;
        if (unansweredStarts >= maximumStarts) return null;
        starts += 1;
        unansweredStarts += 1;
        starting = (async () => {
            const asset = verifiedOperationAsset(options.operationAsset);
            const spawned = await options.spawn(HYPER_V_WINDOWS_SESSION_BOOTSTRAP);
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
            spawned.write(Buffer.from(asset.scriptSource, "utf8").toString("base64"));
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
    let queue: Promise<unknown> = Promise.resolve();

    async function send(
        request: HyperVWindowsExecutionRequest,
        context: HyperVWindowsExecutionContext,
    ): Promise<HyperVWindowsExecutionResult> {
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
            const settle = (result: HyperVWindowsExecutionResult) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                resolve(result);
            };
            // A session that stops answering is the failure that would be worse than the cost this
            // task removes, so the timeout tears the session down rather than only failing the call.
            const timer = setTimeout(() => {
                pending.delete(id);
                discard("hyper-v-windows-session-timeout");
                settle(frameError("hyper-v-windows-session-timeout"));
            }, Math.max(1, context.timeoutMilliseconds));
            if (typeof timer === "object" && timer && "unref" in timer) timer.unref();
            pending.set(id, { resolve: settle, settled: () => done });
            try {
                active.write(`${HYPER_V_WINDOWS_SESSION_REQUEST_PREFIX}${frame}`);
            } catch {
                pending.delete(id);
                discard("hyper-v-windows-session-write-failed");
                settle(frameError("hyper-v-windows-session-write-failed"));
            }
        });
    }

    return {
        execute(request, context) {
            const run = queue.then(() => send(request, context));
            queue = run.catch(() => undefined);
            return run;
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
