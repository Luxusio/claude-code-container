import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";

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

    it("refuses to pool a session once no broker is left to close it", () => {
        // Sessions are handed out lazily from inside async tool handlers, so a request still in
        // flight past the last server's close would otherwise start a PowerShell child nothing ever
        // kills. The session it gets instead reports itself unavailable, which the adapter treats as
        // never-ran and serves through the one-shot transport.
        const orphan = brokerHyperVWindowsSession("powershell.exe");
        expect(brokerHyperVWindowsSessionCountForTest()).toBe(0);
        expect(orphan.starts()).toBe(0);
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
