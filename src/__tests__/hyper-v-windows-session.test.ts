import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it, vi } from "vitest";

import {
    createHyperVWindowsPowerShellSession,
    HYPER_V_WINDOWS_POWERSHELL_ASSET,
    HYPER_V_WINDOWS_POWERSHELL_MEMORY_BOOTSTRAP,
    HYPER_V_WINDOWS_SESSION_BOOTSTRAP,
    HYPER_V_WINDOWS_SESSION_READY_MARKER,
    HYPER_V_WINDOWS_SESSION_REQUEST_PREFIX,
    HYPER_V_WINDOWS_SESSION_RESPONSE_PREFIX,
    type HyperVWindowsExecutionRequest,
    type HyperVWindowsSessionProcess,
} from "../hyper-v-windows/index.js";

// The real pinned asset: the session verifies integrity before spawning, so a placeholder source
// would fail every test for the wrong reason.
const ASSET = {
    scriptPath: "embedded:Invoke-HyperVWindowsOperation.ps1",
    scriptSource: readFileSync(
        join(process.cwd(), "scripts", "host-control", "hyper-v", HYPER_V_WINDOWS_POWERSHELL_ASSET.name),
        "utf8",
    ),
};
const CONTEXT = { timeoutMilliseconds: 5000, maximumOutputBytes: 64 * 1024 };
const REQUEST: HyperVWindowsExecutionRequest = {
    schemaVersion: 1,
    operation: "Get-VM",
    selector: { kind: "id", id: "12345678-1234-4123-8123-123456789abc" },
};

type FakeChild = HyperVWindowsSessionProcess & {
    readonly written: string[];
    readonly killed: () => boolean;
    emit: (line: string) => void;
    exit: (reason: string) => void;
    ready: () => void;
    reply: (frame: string, stdout: string, code?: number) => void;
};

function fakeChild(): FakeChild {
    const written: string[] = [];
    const lineListeners: Array<(line: string) => void> = [];
    const exitListeners: Array<(reason: string) => void> = [];
    let killed = false;
    const child: FakeChild = {
        written,
        killed: () => killed,
        write: (line) => { written.push(line); },
        onLine: (listener) => { lineListeners.push(listener); },
        onExit: (listener) => { exitListeners.push(listener); },
        kill: () => { killed = true; },
        emit: (line) => { for (const listener of [...lineListeners]) listener(line); },
        exit: (reason) => { for (const listener of [...exitListeners]) listener(reason); },
        ready: () => child.emit(HYPER_V_WINDOWS_SESSION_READY_MARKER),
        reply: (frame, stdout, code = 0) => {
            const id = JSON.parse(Buffer.from(frame.slice(HYPER_V_WINDOWS_SESSION_REQUEST_PREFIX.length), "base64").toString("utf8")).id;
            const payload = Buffer.from(JSON.stringify({ id, code, stdout }), "utf8").toString("base64");
            child.emit(`${HYPER_V_WINDOWS_SESSION_RESPONSE_PREFIX}${payload}`);
        },
    };
    return child;
}

// Answers each request as soon as it is written, so a caller's await resolves without the test
// having to interleave manually.
function autoReplyChild(stdout: (index: number) => string): FakeChild {
    const child = fakeChild();
    let served = 0;
    const write = child.write;
    (child as { write: (line: string) => void }).write = (line: string) => {
        write(line);
        if (!line.startsWith(HYPER_V_WINDOWS_SESSION_REQUEST_PREFIX)) return;
        const index = served++;
        queueMicrotask(() => child.reply(line, stdout(index)));
    };
    queueMicrotask(() => child.ready());
    return child;
}

describe("Hyper-V Windows PowerShell session", () => {
    it("serves many primitives from one process and sends the asset source once", async () => {
        const children: FakeChild[] = [];
        const session = createHyperVWindowsPowerShellSession({
            operationAsset: ASSET,
            spawn: () => {
                const child = autoReplyChild((index) => `reply-${index}`);
                children.push(child);
                return child;
            },
        });

        const results = [];
        for (let call = 0; call < 5; call += 1) {
            results.push(await session.execute(REQUEST, CONTEXT));
        }

        expect(results.map((result) => result.stdout)).toEqual(["reply-0", "reply-1", "reply-2", "reply-3", "reply-4"]);
        // The invariant this whole change exists for: five primitives, one process, one module load.
        expect(children).toHaveLength(1);
        expect(session.starts()).toBe(1);
        // First write is the asset source, then exactly one framed request per call.
        expect(children[0]!.written[0]).toBe(Buffer.from(ASSET.scriptSource, "utf8").toString("base64"));
        expect(children[0]!.written.filter((line) => line.startsWith(HYPER_V_WINDOWS_SESSION_REQUEST_PREFIX))).toHaveLength(5);
    });

    it("verifies the pinned asset before any source reaches the child", async () => {
        // Counted, not thrown. A spawn that throws is converted by ensureChild into the same
        // hyper-v-windows-session-unavailable a tampered asset produces, so asserting the error
        // alone proves nothing — the spawn count is the only thing that distinguishes "verified
        // first" from "spawned and then failed".
        let spawns = 0;
        const session = createHyperVWindowsPowerShellSession({
            operationAsset: { ...ASSET, scriptSource: "# tampered" },
            spawn: () => {
                spawns += 1;
                return fakeChild();
            },
        });

        expect((await session.execute(REQUEST, CONTEXT)).error).toBe("hyper-v-windows-session-unavailable");
        expect(spawns).toBe(0);
    });

    it("matches responses by id rather than by arrival order", async () => {
        const child = fakeChild();
        const session = createHyperVWindowsPowerShellSession({ operationAsset: ASSET, spawn: () => child });
        queueMicrotask(() => child.ready());

        const first = session.execute(REQUEST, CONTEXT);
        await vi.waitFor(() => expect(child.written.length).toBe(2));
        // A reply carrying an id nobody awaits must not be handed to the pending caller.
        const foreign = Buffer.from(JSON.stringify({ id: "not-a-pending-id", code: 0, stdout: "wrong" }), "utf8").toString("base64");
        child.emit(`${HYPER_V_WINDOWS_SESSION_RESPONSE_PREFIX}${foreign}`);

        expect((await first).error).toBe("hyper-v-windows-session-response-uncorrelated");
        expect(child.killed()).toBe(true);
    });

    it("frees the pipe when building the frame throws, instead of wedging every later caller", async () => {
        // Nothing in send has a timeout until the frame is built, so a throw before that used to
        // leave the queue waiting on a release that never came — a permanent deadlock of a session
        // the whole process shares, with no error anyone could see.
        const child = autoReplyChild(() => "served");
        const session = createHyperVWindowsPowerShellSession({ operationAsset: ASSET, spawn: () => child });
        const circular: Record<string, unknown> = { schemaVersion: 1, operation: "Get-VM" };
        circular.self = circular;

        await expect(session.execute(circular as unknown as HyperVWindowsExecutionRequest, CONTEXT))
            .rejects.toThrow(/circular|convert/i);
        // The pipe is free: the next caller is served rather than hanging forever.
        expect((await session.execute(REQUEST, CONTEXT)).stdout).toBe("served");
    });

    it("rejects a frame with no exit code instead of reading it as a success", async () => {
        const child = fakeChild();
        const session = createHyperVWindowsPowerShellSession({ operationAsset: ASSET, spawn: () => child });
        queueMicrotask(() => child.ready());

        const first = session.execute(REQUEST, CONTEXT);
        await vi.waitFor(() => expect(child.written.length).toBe(2));
        const id = JSON.parse(Buffer.from(
            child.written[1]!.slice(HYPER_V_WINDOWS_SESSION_REQUEST_PREFIX.length),
            "base64",
        ).toString("utf8")).id;
        // Correctly correlated, but the reader cannot tell whether the operation succeeded. Reading
        // a missing code as 0 would report a native failure as a success envelope with status 0.
        const codeless = Buffer.from(JSON.stringify({ id, stdout: "{}" }), "utf8").toString("base64");
        child.emit(`${HYPER_V_WINDOWS_SESSION_RESPONSE_PREFIX}${codeless}`);

        expect((await first).error).toBe("hyper-v-windows-session-response-invalid");
    });

    it("serializes concurrent callers onto the single stream", async () => {
        const child = fakeChild();
        const session = createHyperVWindowsPowerShellSession({ operationAsset: ASSET, spawn: () => child });
        queueMicrotask(() => child.ready());

        const results = Promise.all([
            session.execute(REQUEST, CONTEXT),
            session.execute(REQUEST, CONTEXT),
            session.execute(REQUEST, CONTEXT),
        ]);

        // Counting frames, not ordering replies. Replies come back in issue order whether or not the
        // frames were serialized, because the session correlates by id — so ordering alone would
        // pass against a transport that wrote all three at once, which is the property this names.
        await vi.waitFor(() => expect(child.written.length).toBe(2));
        for (let index = 0; index < 3; index += 1) {
            expect(child.written).toHaveLength(index + 2);
            child.reply(child.written[index + 1]!, `reply-${index}`);
            if (index < 2) await vi.waitFor(() => expect(child.written.length).toBe(index + 3));
        }

        expect((await results).map((result) => result.stdout)).toEqual(["reply-0", "reply-1", "reply-2"]);
        expect(session.starts()).toBe(1);
    });

    it("recovers from a session that exits, without wedging later calls", async () => {
        const children: FakeChild[] = [];
        const session = createHyperVWindowsPowerShellSession({
            operationAsset: ASSET,
            spawn: () => {
                const child = autoReplyChild(() => "after-restart");
                children.push(child);
                return child;
            },
        });

        expect((await session.execute(REQUEST, CONTEXT)).stdout).toBe("after-restart");
        children[0]!.exit("hyper-v-windows-session-exited");

        expect((await session.execute(REQUEST, CONTEXT)).stdout).toBe("after-restart");
        expect(children).toHaveLength(2);
        expect(session.starts()).toBe(2);
    });

    it("fails an in-flight call when the session exits under it", async () => {
        const child = fakeChild();
        const session = createHyperVWindowsPowerShellSession({ operationAsset: ASSET, spawn: () => child });
        queueMicrotask(() => child.ready());

        const inFlight = session.execute(REQUEST, CONTEXT);
        await vi.waitFor(() => expect(child.written.length).toBe(2));
        child.exit("hyper-v-windows-session-exited");

        expect((await inFlight).error).toBe("hyper-v-windows-session-exited");
    });

    it("tears down a session that stops answering instead of hanging every later call", async () => {
        // The failure that would be worse than the cost this change removes: a child that is alive
        // and accepts writes but never replies.
        const children: FakeChild[] = [];
        const session = createHyperVWindowsPowerShellSession({
            operationAsset: ASSET,
            healthTimeoutMilliseconds: 5,
            spawn: () => {
                const child = children.length === 0 ? fakeChild() : autoReplyChild(() => "recovered");
                if (children.length === 0) queueMicrotask(() => child.ready());
                children.push(child);
                return child;
            },
        });

        const wedged = await session.execute(REQUEST, { ...CONTEXT, timeoutMilliseconds: 5 });
        expect(wedged.error).toBe("hyper-v-windows-session-timeout");
        await vi.waitFor(() => expect(children[0]!.killed()).toBe(true));

        // The next call is served by a fresh session rather than queueing behind the dead one.
        expect((await session.execute(REQUEST, CONTEXT)).stdout).toBe("recovered");
    });

    it("does not kill the shared child because one caller's deadline expired", async () => {
        // The broker bounds each primitive by what is left of its operation deadline, and
        // hyperVRemainingTimeout floors that at 1ms — so a caller can arrive with almost no budget.
        // Treating that as evidence the child is wedged killed a process every other concurrent flow
        // was using, failed them all with an error that is deliberately not retryable, and made the
        // next primitive pay the PowerShell start and module load this whole slice exists to remove.
        const children: FakeChild[] = [];
        const session = createHyperVWindowsPowerShellSession({
            operationAsset: ASSET,
            healthTimeoutMilliseconds: 60000,
            spawn: () => {
                const child = fakeChild();
                queueMicrotask(() => child.ready());
                children.push(child);
                return child;
            },
        });

        const starved = await session.execute(REQUEST, { ...CONTEXT, timeoutMilliseconds: 1 });
        expect(starved.error).toBe("hyper-v-windows-session-timeout");
        expect(children[0]!.killed()).toBe(false);

        // Issued while the abandoned request is still unanswered — the ordering that matters. One
        // stdin and one stdout carry one request at a time, and a caller giving up does not change
        // that, so nothing may be written until the child answers or the health floor fires.
        const queued = session.execute(REQUEST, CONTEXT);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(children[0]!.written).toHaveLength(2);

        // The late answer frees the pipe, and the same child serves the caller that was waiting.
        children[0]!.reply(children[0]!.written[1]!, "late but correlated");
        await vi.waitFor(() => expect(children[0]!.written.length).toBe(3));
        children[0]!.reply(children[0]!.written[2]!, "served");

        expect((await queued).stdout).toBe("served");
        expect(children).toHaveLength(1);
        expect(session.starts()).toBe(1);
    });

    it("expires a queued caller on its own deadline, and says its request never ran", async () => {
        // A queued caller's deadline runs from when it called execute, not from when it reaches the
        // head of the queue. Timing it from inside the write meant a queued caller had no deadline
        // at all and waited out the health floor — up to 120s for a primitive the broker budgeted at
        // seconds, which is the failure the deadline clamp exists to prevent, one layer up.
        const children: FakeChild[] = [];
        const session = createHyperVWindowsPowerShellSession({
            operationAsset: ASSET,
            healthTimeoutMilliseconds: 60000,
            spawn: () => {
                const child = fakeChild();
                queueMicrotask(() => child.ready());
                children.push(child);
                return child;
            },
        });

        expect((await session.execute(REQUEST, { ...CONTEXT, timeoutMilliseconds: 1 })).error)
            .toBe("hyper-v-windows-session-timeout");
        const started = Date.now();
        const queued = await session.execute(REQUEST, { ...CONTEXT, timeoutMilliseconds: 40 });

        // Proportional to its own 40ms budget, not merely "less than the 60s floor" — a bound loose
        // enough to pass at 4.9s would let a partial stall back in unnoticed.
        expect(Date.now() - started).toBeLessThan(1000);
        // A distinct code, because its frame was never written: one request reached the child, and
        // this one provably did not. Only that distinction makes it safe for the broker to re-issue
        // it through the one-shot transport instead of failing it outright.
        expect(queued.error).toBe("hyper-v-windows-session-queue-timeout");
        expect(children[0]!.written).toHaveLength(2);
    });

    it("gives a queued caller back most of its budget instead of spending it waiting", async () => {
        // One session serves every owner, so one slow operation holds the only pipe. The escape is
        // the never-ran classification, which lets the broker serve a queued caller in its own
        // process — but that is worthless if the caller waited out its whole deadline first. At the
        // broker's snapshot call sites the budget is a constant equal to the library's own ceiling,
        // so nothing downstream shortens it: without this bound, one owner's slow snapshot restore
        // costs every other owner the full 120s per primitive, on a seven-primitive chain.
        const children: FakeChild[] = [];
        const session = createHyperVWindowsPowerShellSession({
            operationAsset: ASSET,
            healthTimeoutMilliseconds: 60000,
            queueWaitFraction: 0.25,
            spawn: () => {
                const child = fakeChild();
                queueMicrotask(() => child.ready());
                children.push(child);
                return child;
            },
        });

        // Occupy the pipe with a request the child never answers.
        void session.execute(REQUEST, { ...CONTEXT, timeoutMilliseconds: 60000 });
        await vi.waitFor(() => expect(children[0]!.written.length).toBe(2));

        const started = Date.now();
        const queued = await session.execute(REQUEST, { ...CONTEXT, timeoutMilliseconds: 400 });
        const waited = Date.now() - started;

        expect(queued.error).toBe("hyper-v-windows-session-queue-timeout");
        // A quarter of 400ms, not all of it — the caller still has most of its deadline to spend in
        // its own process.
        expect(waited).toBeLessThan(300);
        // And it never reached the pipe, which is what makes re-issuing it safe.
        expect(children[0]!.written).toHaveLength(2);
    });

    it("refuses to queue at all once the line is too long to be worth joining", async () => {
        // The pipe serves one request at a time, so a caller far back has no realistic chance and is
        // better off in its own process immediately. This is also what bounds the queue's memory:
        // every waiting closure pins its request.
        const children: FakeChild[] = [];
        const session = createHyperVWindowsPowerShellSession({
            operationAsset: ASSET,
            healthTimeoutMilliseconds: 60000,
            maximumQueueDepth: 3,
            spawn: () => {
                const child = fakeChild();
                queueMicrotask(() => child.ready());
                children.push(child);
                return child;
            },
        });

        void session.execute(REQUEST, { ...CONTEXT, timeoutMilliseconds: 60000 });
        await vi.waitFor(() => expect(children[0]!.written.length).toBe(2));
        for (let waiting = 0; waiting < 2; waiting += 1) {
            void session.execute(REQUEST, { ...CONTEXT, timeoutMilliseconds: 60000 });
        }

        // Three are already in the line; this one is turned away without waiting at all.
        const started = Date.now();
        const refused = await session.execute(REQUEST, { ...CONTEXT, timeoutMilliseconds: 60000 });
        expect(refused.error).toBe("hyper-v-windows-session-queue-timeout");
        expect(Date.now() - started).toBeLessThan(200);
        expect(children[0]!.written).toHaveLength(2);
    });

    it("releases a caller that is still queued when the session closes", async () => {
        // A caller waiting for the pipe is not in `pending` yet, so failAll cannot reach it. It is
        // released by ensureChild refusing to start on a closed session when its turn comes.
        const children: FakeChild[] = [];
        const session = createHyperVWindowsPowerShellSession({
            operationAsset: ASSET,
            healthTimeoutMilliseconds: 60000,
            spawn: () => {
                const child = fakeChild();
                queueMicrotask(() => child.ready());
                children.push(child);
                return child;
            },
        });

        const held = session.execute(REQUEST, { ...CONTEXT, timeoutMilliseconds: 60000 });
        await vi.waitFor(() => expect(children[0]!.written.length).toBe(2));
        const stuck = session.execute(REQUEST, { ...CONTEXT, timeoutMilliseconds: 60000 });
        session.close();

        expect((await held).error).toBe("hyper-v-windows-session-closed");
        expect((await stuck).error).toBe("hyper-v-windows-session-unavailable");
        expect(children[0]!.killed()).toBe(true);
    });

    it("kills a child spawned after close rather than orphaning it", async () => {
        // close() discards while child is still null, so the in-flight spawn used to resume and
        // adopt a live PowerShell process into a closed session that nothing would ever kill — a
        // leaked child holding a loaded Hyper-V module.
        const child = fakeChild();
        let release: (() => void) | null = null;
        const session = createHyperVWindowsPowerShellSession({
            operationAsset: ASSET,
            spawn: () => new Promise<HyperVWindowsSessionProcess>((resolve) => {
                release = () => resolve(child);
            }),
        });

        const inFlight = session.execute(REQUEST, CONTEXT);
        await vi.waitFor(() => expect(release).not.toBeNull());
        session.close();
        release!();

        expect((await inFlight).error).toBe("hyper-v-windows-session-unavailable");
        await vi.waitFor(() => expect(child.killed()).toBe(true));
    });

    it("stops respawning once the start budget is exhausted", async () => {
        let spawns = 0;
        const session = createHyperVWindowsPowerShellSession({
            operationAsset: ASSET,
            maximumStarts: 2,
            spawn: () => {
                spawns += 1;
                throw new Error("powershell unavailable");
            },
        });

        expect((await session.execute(REQUEST, CONTEXT)).error).toBe("hyper-v-windows-session-unavailable");
        expect((await session.execute(REQUEST, CONTEXT)).error).toBe("hyper-v-windows-session-unavailable");
        expect((await session.execute(REQUEST, CONTEXT)).error).toBe("hyper-v-windows-session-unavailable");
        // A host that cannot start PowerShell fails fast rather than forking forever.
        expect(spawns).toBe(2);
    });

    it("lets the start budget expire, so a stall cannot demote the broker forever", async () => {
        // Once the cap is reached no start is attempted, so no answer can arrive to reset the
        // counter — without expiry the budget is an absorbing state. Three stalls spread over a
        // broker's lifetime would then leave a perfectly healthy host on the one-shot transport
        // permanently, which is the same class of defect the lifetime counter had.
        let spawns = 0;
        let wedged = true;
        const session = createHyperVWindowsPowerShellSession({
            operationAsset: ASSET,
            maximumStarts: 2,
            healthTimeoutMilliseconds: 5,
            startBudgetWindowMilliseconds: 300,
            spawn: () => {
                spawns += 1;
                const child = wedged ? fakeChild() : autoReplyChild(() => "recovered");
                if (wedged) queueMicrotask(() => child.ready());
                return child;
            },
        });

        // The health floor is never shorter than the caller's own budget, so both are small here.
        const stalling = { ...CONTEXT, timeoutMilliseconds: 5 };
        for (let stall = 0; stall < 2; stall += 1) {
            expect((await session.execute(REQUEST, stalling)).error).toBe("hyper-v-windows-session-timeout");
        }
        expect((await session.execute(REQUEST, stalling)).error).toBe("hyper-v-windows-session-unavailable");
        expect(spawns).toBe(2);

        // The host is healthy again and enough time has passed that the old stalls no longer count.
        wedged = false;
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect((await session.execute(REQUEST, CONTEXT)).stdout).toBe("recovered");
        expect(spawns).toBe(3);
    });

    it("kills the child on close and refuses to start another", async () => {
        const child = autoReplyChild(() => "before-close");
        const session = createHyperVWindowsPowerShellSession({ operationAsset: ASSET, spawn: () => child });

        expect((await session.execute(REQUEST, CONTEXT)).stdout).toBe("before-close");
        session.close();

        // Proving the process is gone, not that close() was called.
        expect(child.killed()).toBe(true);
        expect((await session.execute(REQUEST, CONTEXT)).error).toBe("hyper-v-windows-session-unavailable");
    });

    it("bounds the request frame", async () => {
        const child = autoReplyChild(() => "unused");
        const session = createHyperVWindowsPowerShellSession({ operationAsset: ASSET, spawn: () => child });
        const oversized = {
            ...REQUEST,
            selector: { kind: "name", name: "x".repeat(80 * 1024) },
        } as unknown as HyperVWindowsExecutionRequest;

        expect((await session.execute(oversized, CONTEXT)).error).toBe("hyper-v-windows-session-request-too-large");
    });

    it("resets the start budget once a session answers", async () => {
        // The budget exists for "this host cannot start PowerShell", not "this broker has been up a
        // long time". Counting starts over the process lifetime silently reverted the broker to
        // one-shot forever after the third restart, days apart, with no error anywhere.
        let spawns = 0;
        const children: FakeChild[] = [];
        const session = createHyperVWindowsPowerShellSession({
            operationAsset: ASSET,
            maximumStarts: 2,
            spawn: () => {
                spawns += 1;
                const child = autoReplyChild(() => "served");
                children.push(child);
                return child;
            },
        });

        for (let restart = 0; restart < 4; restart += 1) {
            expect((await session.execute(REQUEST, CONTEXT)).stdout).toBe("served");
            children[children.length - 1]!.exit("hyper-v-windows-session-exited");
        }

        // Four productive sessions, each replaced after it died — none of them evidence that the
        // host cannot run PowerShell.
        expect((await session.execute(REQUEST, CONTEXT)).stdout).toBe("served");
        expect(spawns).toBe(5);
        expect(session.starts()).toBe(5);
    });

    it("ignores a late frame from a discarded child instead of killing its replacement", async () => {
        // Killing a process does not discard what its pipe already delivered, so a stale frame can
        // arrive after the replacement is serving. Unguarded it matched no pending id and tore down
        // the healthy child, failing an unrelated caller with a non-retryable transport error.
        const children: FakeChild[] = [];
        const session = createHyperVWindowsPowerShellSession({
            operationAsset: ASSET,
            healthTimeoutMilliseconds: 5,
            spawn: () => {
                const child = children.length === 0 ? fakeChild() : autoReplyChild(() => "recovered");
                if (children.length === 0) queueMicrotask(() => child.ready());
                children.push(child);
                return child;
            },
        });

        const wedged = await session.execute(REQUEST, { ...CONTEXT, timeoutMilliseconds: 5 });
        expect(wedged.error).toBe("hyper-v-windows-session-timeout");
        const staleFrame = children[0]!.written[1]!;
        await vi.waitFor(() => expect(children[0]!.killed()).toBe(true));
        expect((await session.execute(REQUEST, CONTEXT)).stdout).toBe("recovered");

        children[0]!.reply(staleFrame, "far too late");

        expect(children[1]!.killed()).toBe(false);
        expect((await session.execute(REQUEST, CONTEXT)).stdout).toBe("recovered");
        expect(children).toHaveLength(2);
    });

    it("reports the asset's failure exit code the way the one-shot transport does", async () => {
        const child = autoReplyChild(() => "unused");
        const session = createHyperVWindowsPowerShellSession({ operationAsset: ASSET, spawn: () => child });
        const failure = JSON.stringify({ schemaVersion: 1, operation: "Get-VM", ok: false, errorCode: "virtual-machine-not-found" });
        (child as { write: (line: string) => void }).write = (line: string) => {
            child.written.push(line);
            if (!line.startsWith(HYPER_V_WINDOWS_SESSION_REQUEST_PREFIX)) return;
            queueMicrotask(() => child.reply(line, failure, 1));
        };

        // Same shape a failed one-shot invocation produces: exit status 1 alongside the ok:false
        // envelope, so nothing downstream can tell the two transports apart.
        expect(await session.execute(REQUEST, CONTEXT)).toEqual({ status: 1, stdout: failure });
    });

    it("keeps the operation loop out of the pinned asset", () => {
        // Asserted against the asset, which is what the title claims. Asserting only that the
        // bootstrap contains a loop says nothing about where the loop is NOT: the asset staying
        // one-operation-per-invocation, and byte-identical to what the one-shot transport verifies,
        // is what stops the two transports executing different operation code.
        expect(ASSET.scriptSource).not.toContain(HYPER_V_WINDOWS_SESSION_REQUEST_PREFIX);
        expect(ASSET.scriptSource).not.toContain(HYPER_V_WINDOWS_SESSION_RESPONSE_PREFIX);
        expect(ASSET.scriptSource).not.toContain("[Console]::In.ReadLine()");
        expect(ASSET.scriptSource).not.toMatch(/while\s*\(\s*\$true\s*\)/);

        expect(HYPER_V_WINDOWS_SESSION_BOOTSTRAP).toContain("$Operation = [ScriptBlock]::Create($ScriptSource)");
        expect(HYPER_V_WINDOWS_SESSION_BOOTSTRAP).toContain("$global:CccHyperVJsonInput = [string]$Envelope.input");
        expect(HYPER_V_WINDOWS_SESSION_BOOTSTRAP).toContain(HYPER_V_WINDOWS_SESSION_READY_MARKER);
    });

    it("keeps `exit` out of the asset, because it would take the session down with it", () => {
        // PowerShell's exit is not scoped to a script block. Under `& ([ScriptBlock]::Create(...))`
        // it unwinds past the caller, so an exit on the asset's failure path aborted the Out-String
        // pipeline that was capturing the failure envelope and killed the child — turning an
        // ordinary virtual-machine-not-found into a non-retryable transport error. try/catch cannot
        // intercept it either: exit raises a flow-control exception, which catch does not catch.
        // The asset records failure in a flag and each bootstrap decides what to do with it.
        // Not anchored to line start only: `} catch { ...; exit 1 }` and `if ($x) { exit 1 }` are
        // the same defect on one line.
        expect(ASSET.scriptSource).not.toMatch(/(?:^|[;{]\s*)exit\b/m);
        expect(ASSET.scriptSource).toContain("$global:CccHyperVExitCode = 1");
        expect(ASSET.scriptSource).toContain("$global:CccHyperVExitCode = 0");
        expect(HYPER_V_WINDOWS_SESSION_BOOTSTRAP).toContain("$Code = [int]$global:CccHyperVExitCode");
        expect(HYPER_V_WINDOWS_POWERSHELL_MEMORY_BOOTSTRAP)
            .toContain("if ($global:CccHyperVExitCode) { exit [int]$global:CccHyperVExitCode }");
    });

    it("captures the reply without formatting it", () => {
        // Out-String formats to a host width and is free to insert line breaks into a long JSON
        // envelope, which would reach the reader as response-malformed. 2>&1 would likewise merge
        // the error stream into machine-readable output; the session owner drains stderr instead.
        expect(HYPER_V_WINDOWS_SESSION_BOOTSTRAP).not.toContain("Out-String");
        expect(HYPER_V_WINDOWS_SESSION_BOOTSTRAP).not.toContain("2>&1");
        expect(HYPER_V_WINDOWS_SESSION_BOOTSTRAP).toContain("[string]::Join([string][char]10, @(& $Operation))");
    });
});
