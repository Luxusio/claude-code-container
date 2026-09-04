import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";

import { HYPER_V_WINDOWS_SESSION_READY_MARKER } from "../hyper-v-windows/index.js";

// Kept in step with SESSION_NEVER_RAN_ERRORS in lifecycle-adapter.ts. Membership is the property
// that matters: an error in this set is re-issued through the one-shot transport, one outside it
// fails the caller outright.
const MARKER = HYPER_V_WINDOWS_SESSION_READY_MARKER;

// These drive a real spawned process, because the latch is the one piece of the pool that decides
// whether the broker re-issues a request and nothing else here exercises a real child. They are
// skipped on Windows, where a `#!/bin/sh` file is unspawnable and yields spawn-failed — which fails
// every assertion here, positive and negative alike. That would break `npm test` on the platform
// this subsystem targets, which is where someone is most likely to run it.
async function runStub(script: string, timeoutMilliseconds: number) {
    const stub = join(mkdtempSync(join(tmpdir(), "ccc-session-stub-")), "stub.sh");
    writeFileSync(stub, script, { mode: 0o755 });
    const release = retainBrokerHyperVWindowsSessions();
    try {
        return await brokerHyperVWindowsSession(stub).execute(
            { schemaVersion: 1, operation: "Get-VM", selector: { kind: "name", name: "ccc" } },
            { timeoutMilliseconds, maximumOutputBytes: 64 * 1024 },
        );
    } finally {
        release();
    }
}

import {
    brokerHyperVWindowsSession,
    brokerHyperVWindowsSessionCountForTest,
    HYPER_V_WINDOWS_CHILD_DEATH_EVENTS,
    hyperVWindowsChildDeathCode,
    retainBrokerHyperVWindowsSessions,
} from "../device-lab/broker/hyper-v/session-pool.js";

// The pool is module scoped, so every test releases what it retains and drains the map before it
// returns. A leaked holder would make a later test's release a no-op and hide a real regression.
function drain(): void {
    retainBrokerHyperVWindowsSessions()();
}

describe("child death classification", () => {
    // The whole decision, every combination, no child processes. This exists because the review that
    // prompted it measured that five of fourteen invariants in this area were pinned: guards had
    // accumulated until two covered the same property, and a test written for one silently began
    // passing because of the other, so the guard it named could be deleted with the suite still
    // green. Process-level tests are good at proving the wiring works and provably bad at pinning
    // individual rules; this table is the opposite, and the two together are the coverage.
    // Imported, never re-listed here. The type is derived from this same array, so the table covers
    // every event by construction. A local copy would be free to fall behind — nothing typechecks
    // this directory, so a stale list would fail nothing and silently shrink the table.
    const EVENTS = HYPER_V_WINDOWS_CHILD_DEATH_EVENTS;
    const NEVER_RAN_CODES = new Set(["hyper-v-windows-session-start-failed", "hyper-v-windows-session-spawn-failed"]);

    const rows = EVENTS.flatMap((event) => [true, false].flatMap((announcedReady) =>
        [true, false].flatMap((latchEvidenceLost) => [true, false].map((spawned) => ({
            event,
            state: { announcedReady, latchEvidenceLost, spawned },
            code: hyperVWindowsChildDeathCode(event, { announcedReady, latchEvidenceLost, spawned }),
        })))));

    it("only calls a request never-ran when nothing proves the child reached its read loop", () => {
        for (const row of rows) {
            const retryable = NEVER_RAN_CODES.has(row.code);
            // The one safety property, stated once over the whole space: a request may be re-issued
            // only when the child provably never got far enough to run it. Anything else — it
            // announced, or the evidence was thrown away, or we never waited for stdio to drain —
            // must not be retried, because a second Remove-VMSnapshot is not the same as the first.
            // `exit-grace` and `error` are both excluded because neither guarantees stdio drained,
            // so a false latch on those paths proves nothing. Only `close` (drained by definition)
            // and `exit` (which reports early only when the latch is already set, and the latch is
            // monotone) can support a never-ran verdict.
            const drained = row.event === "close" || row.event === "exit";
            const provablyNeverRan = !row.state.spawned
                ? true
                : drained && !row.state.latchEvidenceLost && !row.state.announcedReady;
            expect({ ...row, retryable }).toEqual({ ...row, retryable: provablyNeverRan });
        }
    });

    it("never reports a spawn failure for a child that spawned", () => {
        // spawn-failed is never-ran, so naming a live child's error with it would tell the broker a
        // request that may already have run Remove-VMSnapshot is safe to re-issue.
        for (const row of rows.filter((candidate) => candidate.state.spawned)) {
            expect(row.code).not.toBe("hyper-v-windows-session-spawn-failed");
        }
    });

    it("treats lost evidence and a missing drain as not-proof, never as proof", () => {
        // Three separate reasons the latch may read false without meaning anything: output was
        // dropped unread, `close` never came so stdio never drained, or the death arrived as an
        // `error` event, which carries no drain guarantee at all. Each used to be a one-line guard in
        // a different handler, or in the `error` case no guard whatsoever; all are rules here.
        for (const row of rows.filter((candidate) => candidate.state.latchEvidenceLost
            || candidate.event === "exit-grace"
            || candidate.event === "error")) {
            // A child that never spawned is decided before any of this, on the stronger fact.
            if (!row.state.spawned) continue;
            expect(row.code).toBe("hyper-v-windows-session-exited");
        }
    });

    it("never calls an announced child's request never-ran, on any path", () => {
        for (const row of rows.filter((candidate) => candidate.state.announcedReady && candidate.state.spawned)) {
            expect(NEVER_RAN_CODES.has(row.code)).toBe(false);
        }
    });

    it("still lets a crash-on-start child fall back", () => {
        // The complement, and the reason the latch exists: a child that spawned, announced nothing
        // and lost nothing did not run the request, so the broker serves it one-shot rather than
        // failing it outright.
        //
        // Derived, not written out. This list previously held a hardcoded "stdin-error" that
        // outlived the union member: the argument still satisfied the assertion by falling through
        // every branch, so the test stayed green while asserting something about an input no caller
        // could produce, and nothing typechecks this directory to say otherwise.
        // Only the two events that carry a drain guarantee. `exit-grace` means `close` never came,
        // and `error` carries no drain guarantee either — on both, a false latch proves nothing and
        // the classifier deliberately declines to call it never-ran.
        for (const event of EVENTS.filter((candidate) => candidate === "close" || candidate === "exit")) {
            expect(hyperVWindowsChildDeathCode(event, {
                announcedReady: false,
                latchEvidenceLost: false,
                spawned: true,
            })).toBe("hyper-v-windows-session-start-failed");
        }
    });
});

describe("broker Hyper-V session pool", () => {
    it("hands the same session to every caller naming the same executable", () => {
        const release = retainBrokerHyperVWindowsSessions();
        try {
            const first = brokerHyperVWindowsSession("powershell.exe");
            const second = brokerHyperVWindowsSession("powershell.exe");
            const other = brokerHyperVWindowsSession("pwsh.exe");

            // Reuse is the entire point: a second session per caller would reintroduce the
            // process-per-flow cost this pool exists to remove.
            expect(second).toBe(first);
            expect(other).not.toBe(first);
            expect(brokerHyperVWindowsSessionCountForTest()).toBe(2);
        } finally {
            release();
        }
        expect(brokerHyperVWindowsSessionCountForTest()).toBe(0);
    });

    it("keeps sessions alive until the last broker in the process releases them", () => {
        const first = retainBrokerHyperVWindowsSessions();
        const second = retainBrokerHyperVWindowsSessions();
        try {
            brokerHyperVWindowsSession("powershell.exe");
            expect(brokerHyperVWindowsSessionCountForTest()).toBe(1);

            first();
            // A process can hold more than one broker server. Closing on the first one's close event
            // would kill a child the second is mid-request on, and hyper-v-windows-session-closed is
            // deliberately not retryable — that request would fail outright rather than fall back.
            expect(brokerHyperVWindowsSessionCountForTest()).toBe(1);

            second();
            expect(brokerHyperVWindowsSessionCountForTest()).toBe(0);
        } finally {
            first();
            second();
            drain();
        }
    });

    describe.skipIf(process.platform === "win32")("readiness latch", () => {
    it("classifies a child that never announced itself as never having run anything", { timeout: 20000 }, async () => {
        // `sleep 0.2` before exiting, not an instant exit. An instantly-dead child resolves on the
        // write path — both write callbacks EPIPE — so the test passes with the latch deleted
        // entirely and guards nothing. Living long enough for the writes to be accepted forces the
        // classification through the latch, which is the code this is here to protect.
        const result = await runStub("#!/bin/sh\nsleep 0.2\n", 2000);
        expect(result.error).toBe("hyper-v-windows-session-start-failed");
    });

    it("does not call a child that announced itself never-ran", async () => {
        // The direction that matters most: a child that reached its read loop may have executed what
        // it was sent, so re-issuing could apply a mutation twice. Announces, accepts both writes,
        // then dies silently — indistinguishable to the pool from a real child that read a frame and
        // died mid-operation.
        const result = await runStub(`#!/bin/sh\necho ${MARKER}\nsleep 0.2\n`, 2000);
        // The exact code, not merely "not never-ran": a caller that outran its own budget would
        // report session-timeout, which also satisfies not-never-ran while testing nothing.
        expect(result.error).toBe("hyper-v-windows-session-exited");
    });

    it("never reports a stale-latch never-ran when writing to the child fails", async () => {
        // The child closes its stdin read end immediately, so every write EPIPEs, and announces only
        // afterwards. That is the shape in which the readiness latch is provably stale at the moment
        // the stdin stream error fires: the marker has not been read yet, so the latch says false
        // about a child that is about to prove otherwise.
        //
        // TWO orderings are possible here, and this asserts the property both must satisfy rather
        // than the outcome of either — measured 4/5 and 1/5 across runs on this machine:
        //   write callback first -> `settled` marks the frame undelivered, notifyExit reports
        //     stdin-failed (a never-ran established by nothing having been flushed), discard() nulls
        //     the child, and the stdin handler's later report is eaten by the identity guard.
        //   stream error first  -> the stdin handler reports `exited`. Lossy — the fallback is lost —
        //     but safe, and the write callback's notifyExit is then dropped by the identity guard.
        //
        // Do NOT rewrite this to assert a single code. An earlier draft asserted stdin-failed and
        // failed 1 run in 5; the ordering is not guaranteed, which is exactly why the handler must
        // not classify. Reverting it to `report("error")` — which compiles, since "error" is the
        // name the stream event actually has — returns start-failed in the second ordering: a
        // never-ran verdict on a child that reached its read loop, re-issuing a Remove-VMSnapshot.
        // This catches that, though only on the runs that take the second ordering.
        const result = await runStub(`#!/bin/sh\nexec 0<&-\nsleep 0.1\necho ${MARKER}\nsleep 0.2\n`, 4000);
        expect([
            "hyper-v-windows-session-spawn-failed",
            "hyper-v-windows-session-start-failed",
        ]).not.toContain(result.error);
        // Positively: it must still be one of the two sound answers, not some third thing.
        expect([
            "hyper-v-windows-session-stdin-failed",
            "hyper-v-windows-session-exited",
        ]).toContain(result.error);
    });

    it("recognises the marker through a byte-order mark", async () => {
        // [Console]::Out writes through the console's encoding, and some UTF-8 console setups emit a
        // BOM on the first write. Exact equality missed it, so a child that announced and then died
        // was classified never-ran and re-issued — 20/20, silently, for the child's whole life.
        const result = await runStub(`#!/bin/sh\nprintf '\\357\\273\\277%s\\n' ${MARKER}\nsleep 0.2\n`, 2000);
        // The exact code, not merely "not never-ran": a caller that outran its own budget would
        // report session-timeout, which also satisfies not-never-ran while testing nothing.
        expect(result.error).toBe("hyper-v-windows-session-exited");
    });

    it("does not lose the marker when a flood forces the line buffer to be dropped", async () => {
        // The buffer drop exists so an un-newlined child cannot exhaust memory, but it also discards
        // whatever evidence that buffer held. Since the latch reads absence of evidence as proof
        // that nothing ran, a child emitting one long un-newlined run before announcing would have
        // every later request re-issued. Lost evidence now forces the conservative answer instead.
        const result = await runStub(
            `#!/bin/sh\nawk 'BEGIN { while (i++ < 600) printf "%0512000d", 0 }'\necho ${MARKER}\nsleep 0.2\n`,
            8000,
        );
        // The exact code, not merely "not never-ran": a caller that outran its own budget would
        // report session-timeout, which also satisfies not-never-ran while testing nothing. This one
        // pipes ~300MB, so the budget is generous — but a loose assertion would let a slow box turn
        // the test quiet instead of red.
        expect(result.error).toBe("hyper-v-windows-session-exited");
    });

    it("reports a death whose `close` a surviving grandchild is holding open", async () => {
        // Four lines of shell for the last uncovered duplicate-mutation path, and it discriminates
        // two separate changes at once.
        //
        // `close` fires only after every stdio stream closes, and a grandchild inheriting stdout
        // keeps it open — so listening to `close` alone means the death is never reported and the
        // shared pipe is held until the health floor expires with a code that is not retryable.
        // Listening to `exit` alone reads the latch before stdio has drained. Hence both, with the
        // grace timer choosing the CONSERVATIVE code: reporting `exitReason` from there instead
        // would call this never-ran and have the broker re-issue it. That single word is the whole
        // guard, and it is what this pins.
        const result = await runStub("#!/bin/sh\nsh -c 'sleep 10' &\nsleep 0.2\nexit 1\n", 8000);
        expect(result.error).toBe("hyper-v-windows-session-exited");
    });

    it("does not accept the marker on stderr", async () => {
        // stderr cannot carry the ready marker — the bootstrap writes it to stdout — so seeing it
        // there proves nothing about whether the read loop was reached. Allowing stderr to set the
        // latch is exactly what made an earlier revision wrong, and it silently costs the fallback:
        // this child would be classified as having run something it never read.
        const result = await runStub(`#!/bin/sh\necho ${MARKER} >&2\nsleep 0.2\n`, 2000);
        expect(result.error).toBe("hyper-v-windows-session-start-failed");
    });

    it("treats output dropped unread as evidence lost, not as proof nothing ran", async () => {
        // The flood test above cannot cover this: its stub announces, so the latch is satisfied by
        // the marker rather than by the drop. This one never announces at all, so the ONLY thing
        // between it and a never-ran classification is the drop recording that it destroyed
        // evidence. Getting this wrong re-issues a request the child may have executed.
        const result = await runStub(
            "#!/bin/sh\nawk 'BEGIN { while (i++ < 40) printf \"%0512000d\", 0 }'\nsleep 0.2\n",
            8000,
        );
        expect(result.error).toBe("hyper-v-windows-session-exited");
    });

    it("recognises the marker behind a prefix on its line", async () => {
        // trim() covers a BOM and whitespace, not text. A child that printed anything ahead of the
        // marker on the same line was classified never-ran and re-issued, 15/15 — and that is
        // exactly the crash-on-start window this mechanism exists for, where the child had already
        // reached its read loop.
        const result = await runStub(`#!/bin/sh\nprintf 'noise%s\\n' ${MARKER}\nsleep 0.2\n`, 2000);
        expect(result.error).toBe("hyper-v-windows-session-exited");
    });
    });

    it("refuses to pool a session once no broker is left to close it", async () => {
        // Sessions are handed out lazily from inside async tool handlers, so a request still in
        // flight past the last server's close would otherwise start a PowerShell child nothing ever
        // kills. The session it gets instead reports itself unavailable, which the adapter treats as
        // never-ran and serves through the one-shot transport.
        const orphan = brokerHyperVWindowsSession("powershell.exe");
        expect(brokerHyperVWindowsSessionCountForTest()).toBe(0);
        // What it does, not that it exists: reporting itself unavailable is what routes the straggler
        // to the one-shot transport, because that code is the adapter's never-ran signal.
        const result = await orphan.execute(
            { schemaVersion: 1, operation: "Get-VM", selector: { kind: "name", name: "ccc" } },
            { timeoutMilliseconds: 1000, maximumOutputBytes: 1024 },
        );
        expect(result).toEqual({ status: null, stdout: "", error: "hyper-v-windows-session-unavailable" });
    });

    it("is retained by the broker at construction, not at close", async () => {
        // The wiring, not the pool. `server.once("close", retainBrokerHyperVWindowsSessions())` and
        // `server.once("close", retainBrokerHyperVWindowsSessions)` differ by two characters; the
        // second retains on close and never releases, pinning the pool open forever. Every
        // pool-level test above passes either way.
        const { createDeviceBrokerServer } = await import("../device-lab-broker.js");
        const home = process.env.HOME;
        // Constructing a server registers owner state under HOME, which is read-only here.
        process.env.HOME = mkdtempSync(join(tmpdir(), "ccc-session-pool-home-"));
        const server = createDeviceBrokerServer({
            cwd: mkdtempSync(join(tmpdir(), "ccc-session-pool-cwd-")),
            host: "127.0.0.1",
            port: 0,
            platform: "linux",
            // `mode` and `provider` are required, and omitting them typechecked only because nothing
            // typechecked this directory. The pool test never inspects either, but a stub that does
            // not satisfy the real contract is how a test starts passing on a shape the code cannot
            // produce.
            commandRunner: () => ({ mode: "test", provider: "hyper-v", status: 0, stdout: "" }),
        });
        try {
            // Only poolable while a holder exists — otherwise the count stays 0.
            brokerHyperVWindowsSession("powershell.exe");
            expect(brokerHyperVWindowsSessionCountForTest()).toBe(1);
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
        }
        expect(brokerHyperVWindowsSessionCountForTest()).toBe(0);
    });

    it("ignores a repeated release rather than dropping another holder's count", () => {
        const doubled = retainBrokerHyperVWindowsSessions();
        const other = retainBrokerHyperVWindowsSessions();
        try {
            brokerHyperVWindowsSession("powershell.exe");
            doubled();
            doubled();
            doubled();

            // Node emits "close" once, but a release that decremented on every call would let one
            // server's repeated close tear down sessions the other still owns.
            expect(brokerHyperVWindowsSessionCountForTest()).toBe(1);
        } finally {
            other();
            drain();
        }
        expect(brokerHyperVWindowsSessionCountForTest()).toBe(0);
    });
});
