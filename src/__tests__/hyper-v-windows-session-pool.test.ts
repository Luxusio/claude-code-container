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
