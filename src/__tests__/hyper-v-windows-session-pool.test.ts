import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";

import { HYPER_V_WINDOWS_SESSION_READY_MARKER } from "../hyper-v-windows/index.js";

// Kept in step with SESSION_NEVER_RAN_ERRORS in lifecycle-adapter.ts. Membership is the property
// that matters: an error in this set is re-issued through the one-shot transport, one outside it
// fails the caller outright.
const NEVER_RAN = [
    "hyper-v-windows-session-unavailable",
    "hyper-v-windows-session-spawn-failed",
    "hyper-v-windows-session-start-failed",
    "hyper-v-windows-session-queue-timeout",
    "hyper-v-windows-session-write-failed",
    "hyper-v-windows-session-stdin-failed",
];

import {
    brokerHyperVWindowsSession,
    brokerHyperVWindowsSessionCountForTest,
    retainBrokerHyperVWindowsSessions,
} from "../device-lab/broker/hyper-v/session-pool.js";

// The pool is module scoped, so every test releases what it retains and drains the map before it
// returns. A leaked holder would make a later test's release a no-op and hide a real regression.
function drain(): void {
    retainBrokerHyperVWindowsSessions()();
}

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

    it("classifies a child that never announced itself as never having run anything", async () => {
        // Against a real spawned process, because this is the one behaviour in the pool that decides
        // whether the broker re-issues a request, and nothing else here drives a real child. A binary
        // that exists and exits immediately — a stub PowerShell, a broken install, an antivirus kill
        // — must be served through the one-shot transport rather than failing outright.
        const release = retainBrokerHyperVWindowsSessions();
        try {
            const session = brokerHyperVWindowsSession("/bin/true");
            const result = await session.execute(
                { schemaVersion: 1, operation: "Get-VM", selector: { kind: "name", name: "ccc" } },
                { timeoutMilliseconds: 2000, maximumOutputBytes: 64 * 1024 },
            );
            // Asserted as membership, not as one code: the write path and the exit path both reach
            // never-ran by their own route, and which one wins is a race. What must never happen is
            // an error outside this set, because that fails the caller outright instead of falling
            // back — which is what this case did on every attempt before the latch.
            expect(NEVER_RAN).toContain(result.error);
        } finally {
            release();
        }
    });

    it("does not call a child that announced itself never-ran", async () => {
        // The other direction, and the one that matters most: a child that reached its read loop may
        // have executed what it was sent, so re-issuing could apply a mutation twice. This stub
        // announces itself exactly as the bootstrap does and then goes quiet, which is
        // indistinguishable — to the pool — from a real child that read a frame and stalled.
        const stub = join(mkdtempSync(join(tmpdir(), "ccc-ready-stub-")), "stub.sh");
        writeFileSync(stub, `#!/bin/sh\necho ${HYPER_V_WINDOWS_SESSION_READY_MARKER}\nsleep 5\n`, { mode: 0o755 });
        const release = retainBrokerHyperVWindowsSessions();
        try {
            const session = brokerHyperVWindowsSession(stub);
            const result = await session.execute(
                { schemaVersion: 1, operation: "Get-VM", selector: { kind: "name", name: "ccc" } },
                { timeoutMilliseconds: 250, maximumOutputBytes: 64 * 1024 },
            );
            expect(NEVER_RAN).not.toContain(result.error);
        } finally {
            release();
        }
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
            commandRunner: () => ({ status: 0, stdout: "" }),
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
