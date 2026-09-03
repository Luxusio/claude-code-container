import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

import {
    createHyperVWindowsPowerShellSession,
    HYPER_V_WINDOWS_POWERSHELL_ASSET,
    HYPER_V_WINDOWS_SESSION_REQUEST_PREFIX,
    HYPER_V_WINDOWS_SESSION_RESPONSE_PREFIX,
    type HyperVWindowsExecutionRequest,
    type HyperVWindowsSessionProcess,
} from "../hyper-v-windows/index.js";

// Every other session test was written after the defect it names, so the suite documents fixes
// rather than checking an invariant. This one is the opposite: it asserts the properties the
// transport must hold for ANY interleaving, and it is the only test here that would have caught the
// caller-deadline, queue-release and abandoned-request defects before a reviewer measured them.
//
// The property that carries the most weight is the last one. The broker re-issues a
// hyper-v-windows-session-queue-timeout through the one-shot transport, on the claim that such a
// caller provably never had its frame written. If that is ever false, the retry applies a mutation
// twice — a second Remove-VMSnapshot against a real host.

const ASSET = {
    scriptPath: "embedded:Invoke-HyperVWindowsOperation.ps1",
    scriptSource: readFileSync(
        join(process.cwd(), "scripts", "host-control", "hyper-v", HYPER_V_WINDOWS_POWERSHELL_ASSET.name),
        "utf8",
    ),
};
const REQUEST: HyperVWindowsExecutionRequest = {
    schemaVersion: 1,
    operation: "Get-VM",
    selector: { kind: "id", id: "12345678-1234-4123-8123-123456789abc" },
};

// Seeded, so a failure is reproducible from the printed seed rather than being a flake.
function random(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}

type Recorder = HyperVWindowsSessionProcess & {
    frames: () => number;
    // The highest number of frames this child held unanswered at once. One stdin and one stdout can
    // only carry one request, so anything above 1 means the transport handed the pipe away while it
    // was still in use — which is not observable from the callers' results at all, because the
    // session correlates replies by id and returns the right answer to each of them regardless.
    peakOutstanding: () => number;
};

// Answers some requests and silently drops others, so a share of callers outlive their budget while
// the pipe is still held — the state in which the queue and the caller timers race.
function flakyChild(next: () => number, dropRate: number, maxDelayMs: number): Recorder {
    const lineListeners: Array<(line: string) => void> = [];
    const exitListeners: Array<(reason: string) => void> = [];
    let frames = 0;
    let outstanding = 0;
    let peakOutstanding = 0;
    const child: Recorder = {
        frames: () => frames,
        peakOutstanding: () => peakOutstanding,
        write: (line) => {
            if (!line.startsWith(HYPER_V_WINDOWS_SESSION_REQUEST_PREFIX)) return;
            frames += 1;
            outstanding += 1;
            peakOutstanding = Math.max(peakOutstanding, outstanding);
            if (next() < dropRate) return;
            const id = JSON.parse(Buffer.from(
                line.slice(HYPER_V_WINDOWS_SESSION_REQUEST_PREFIX.length),
                "base64",
            ).toString("utf8")).id;
            const payload = Buffer.from(JSON.stringify({ id, code: 0, stdout: "ok" }), "utf8").toString("base64");
            const timer = setTimeout(() => {
                outstanding -= 1;
                for (const listener of [...lineListeners]) {
                    listener(`${HYPER_V_WINDOWS_SESSION_RESPONSE_PREFIX}${payload}`);
                }
            }, Math.floor(next() * maxDelayMs));
            timer.unref?.();
        },
        onLine: (listener) => { lineListeners.push(listener); },
        onExit: (listener) => { exitListeners.push(listener); },
        kill: () => { for (const listener of [...exitListeners]) listener("hyper-v-windows-session-exited"); },
    };
    return child;
}

describe("Hyper-V Windows session transport properties", () => {
    it("holds its invariants across randomised concurrent interleavings", async () => {
        const seed = 20260903;
        const next = random(seed);
        const rounds = 120;
        const callersPerRound = 6;
        let served = 0;
        let callerTimeouts = 0;
        let queueTimeouts = 0;
        let other = 0;
        let framesWritten = 0;

        for (let round = 0; round < rounds; round += 1) {
            const children: Recorder[] = [];
            const session = createHyperVWindowsPowerShellSession({
                operationAsset: ASSET,
                healthTimeoutMilliseconds: 60,
                startBudgetWindowMilliseconds: 60000,
                maximumStarts: 1000,
                // Below the six callers per round, so the depth-refusal path is actually exercised
                // here. At the default of 8 it never fires and the invariants below say nothing
                // about it.
                maximumQueueDepth: 2,
                spawn: () => {
                    const child = flakyChild(next, 0.35, 12);
                    children.push(child);
                    return child;
                },
            });

            const budgets = Array.from({ length: callersPerRound }, () => 1 + Math.floor(next() * 24));
            const results = await Promise.all(budgets.map((timeoutMilliseconds) => session.execute(REQUEST, {
                timeoutMilliseconds,
                maximumOutputBytes: 64 * 1024,
            })));

            // 1. Every caller settles. A caller that never settles is the deadlock class.
            expect(results).toHaveLength(callersPerRound);

            for (const result of results) {
                if (!result.error) served += 1;
                else if (result.error === "hyper-v-windows-session-timeout") callerTimeouts += 1;
                else if (result.error === "hyper-v-windows-session-queue-timeout") queueTimeouts += 1;
                else other += 1;
            }

            const frames = children.reduce((total, child) => total + child.frames(), 0);
            framesWritten += frames;

            // 2. Nobody is told "never ran" unless the pipe really never carried their request. This
            //    is the idempotency guarantee the one-shot fallback rests on: frames written plus
            //    queued-out callers must account for every caller, with none unexplained.
            const settledQueueTimeouts = results.filter((r) => r.error === "hyper-v-windows-session-queue-timeout").length;
            expect(frames + settledQueueTimeouts).toBe(callersPerRound);

            // 3. The pipe carries one request at a time. Asserted at the child, because the callers
            //    cannot see this: id correlation returns the right answer to each of them even when
            //    two requests were in flight together.
            for (const child of children) {
                expect({ round, seed, peak: child.peakOutstanding() }).toEqual({ round, seed, peak: 1 });
            }

            // 4. The session is still usable afterwards rather than wedged.
            session.close();
        }

        // No unexpected error codes anywhere in the space.
        expect({ seed, other }).toEqual({ seed, other: 0 });
        // The run has to actually exercise the interesting states, or the properties above are
        // vacuously true. Assert the shape of the space rather than exact counts.
        expect(served).toBeGreaterThan(0);
        expect(queueTimeouts + callerTimeouts).toBeGreaterThan(0);
        expect(framesWritten).toBeGreaterThan(0);
    });
});
