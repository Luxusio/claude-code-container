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
        const session = createHyperVWindowsPowerShellSession({
            operationAsset: { ...ASSET, scriptSource: "# tampered" },
            spawn: () => {
                throw new Error("spawn must not be reached when the asset fails verification");
            },
        });
        // Integrity is checked before spawning, so a tampered asset cannot start a session at all.
        expect((await session.execute(REQUEST, CONTEXT)).error).toBe("hyper-v-windows-session-unavailable");
    });

    it("matches responses by id rather than by arrival order", async () => {
        const child = fakeChild();
        const session = createHyperVWindowsPowerShellSession({ operationAsset: ASSET, spawn: () => child });
        queueMicrotask(() => child.ready());

        const first = session.execute(REQUEST, CONTEXT);
        await vi.waitFor(() => expect(child.written.length).toBe(2));
        const frame = child.written[1]!;
        // A reply carrying an id nobody awaits must not be handed to the pending caller.
        const foreign = Buffer.from(JSON.stringify({ id: "not-a-pending-id", stdout: "wrong" }), "utf8").toString("base64");
        child.emit(`${HYPER_V_WINDOWS_SESSION_RESPONSE_PREFIX}${foreign}`);

        expect((await first).error).toBe("hyper-v-windows-session-response-uncorrelated");
        expect(child.killed()).toBe(true);
        void frame;
    });

    it("serializes concurrent callers onto the single stream", async () => {
        const child = autoReplyChild((index) => `reply-${index}`);
        const session = createHyperVWindowsPowerShellSession({ operationAsset: ASSET, spawn: () => child });

        const results = await Promise.all([
            session.execute(REQUEST, CONTEXT),
            session.execute(REQUEST, CONTEXT),
            session.execute(REQUEST, CONTEXT),
        ]);

        // One request in flight at a time: replies come back in issue order, never interleaved.
        expect(results.map((result) => result.stdout)).toEqual(["reply-0", "reply-1", "reply-2"]);
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
            spawn: () => {
                const child = children.length === 0 ? fakeChild() : autoReplyChild(() => "recovered");
                if (children.length === 0) queueMicrotask(() => child.ready());
                children.push(child);
                return child;
            },
        });

        const wedged = await session.execute(REQUEST, { ...CONTEXT, timeoutMilliseconds: 5 });
        expect(wedged.error).toBe("hyper-v-windows-session-timeout");
        expect(children[0]!.killed()).toBe(true);

        // The next call is served by a fresh session rather than queueing behind the dead one.
        expect((await session.execute(REQUEST, CONTEXT)).stdout).toBe("recovered");
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
        // The asset stays one-operation-per-invocation and byte-identical to what the one-shot
        // transport verifies; only the bootstrap loops. That is what stops the two transports
        // executing different operation code.
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
        expect(ASSET.scriptSource).not.toMatch(/^\s*exit\b/m);
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
