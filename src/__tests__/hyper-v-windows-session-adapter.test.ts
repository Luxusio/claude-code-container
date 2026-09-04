import { describe, expect, it, vi } from "vitest";

import {
    createDeviceLabHyperVWindowsClient,
    createRecordingDeviceLabHyperVWindowsClient,
    SESSION_NEVER_RAN_ERRORS,
} from "../device-lab/broker/hyper-v/lifecycle-adapter.js";
import {
    HYPER_V_WINDOWS_SESSION_ERROR_CODES,
    type HyperVWindowsSessionErrorCode,
} from "../hyper-v-windows/index.js";
import { redactProviderCommandInput } from "../device-lab/broker/hyper-v/public-response.js";
import type {
    HyperVWindowsError,
    HyperVWindowsExecutionRequest,
    HyperVWindowsExecutionResult,
    HyperVWindowsExecutor,
} from "../hyper-v-windows/index.js";

const VM_ID = "12345678-1234-4123-8123-123456789abc";

function envelope(items: unknown[]): string {
    return JSON.stringify({ schemaVersion: 1, operation: "Get-VM", ok: true, items });
}

function sessionReturning(result: HyperVWindowsExecutionResult): HyperVWindowsExecutor & { calls: () => number } {
    let calls = 0;
    return {
        calls: () => calls,
        execute: () => {
            calls += 1;
            return result;
        },
    };
}

describe("Device Lab Hyper-V session transport", () => {
    const machine = {
        id: VM_ID,
        name: "ccc-vm",
        state: "Off",
        status: "Operating normally",
        notes: "",
        uptimeMilliseconds: 0,
        generation: 2,
        checkpointType: "Production",
    };

    it("serves the operation from the session without touching the one-shot runner", async () => {
        const run = vi.fn();
        const session = sessionReturning({ status: 0, stdout: envelope([machine]) });
        const client = createDeviceLabHyperVWindowsClient({
            executable: "powershell.exe",
            timeoutMilliseconds: 1000,
            run,
            session,
        });

        expect((await client.getVM({ kind: "id", id: VM_ID }))[0]?.id).toBe(VM_ID);
        expect(session.calls()).toBe(1);
        // The whole point: no per-primitive process.
        expect(run).not.toHaveBeenCalled();
    });

    it("falls back to the one-shot runner only when the session never came up", async () => {
        const run = vi.fn(async () => ({ status: 0, stdout: envelope([machine]) }));
        for (const error of [
            "hyper-v-windows-session-unavailable",
            "hyper-v-windows-session-spawn-failed",
            "hyper-v-windows-session-start-failed",
            // Expired while still queued, so its frame was never written. One session is shared
            // process-wide, so without this a single wedged operation would take every other
            // Hyper-V primitive down with it rather than letting them run one-shot.
            "hyper-v-windows-session-queue-timeout",
            // The write of this request's own frame failed, so nothing reached the child. A
            // PowerShell that spawns and dies immediately produces exactly this, and it used to fail
            // the first primitives outright rather than serving them the way it did before sessions.
            "hyper-v-windows-session-write-failed",
            "hyper-v-windows-session-stdin-failed",
        ]) {
            run.mockClear();
            const client = createDeviceLabHyperVWindowsClient({
                executable: "powershell.exe",
                timeoutMilliseconds: 1000,
                run,
                session: sessionReturning({ status: null, stdout: "", error }),
            });
            expect((await client.getVM({ kind: "id", id: VM_ID }))[0]?.id).toBe(VM_ID);
            expect(run).toHaveBeenCalledTimes(1);
        }
    });

    // Every session error code, split into the two halves of the retry decision. This is a PARTITION,
    // asserted total and disjoint below, and that is the point: the never-ran set used to be an
    // allowlist with no constraint on what could join it. Mutation testing proved the gap — adding
    // `hyper-v-windows-session-closed` to SESSION_NEVER_RAN_ERRORS passed tsc, typecheck:tests, lint
    // and all 1188 hyper-v/device-lab tests, because `satisfies` checks spelling and nothing checked
    // safety. Only three of the fifteen codes were asserted non-retryable; the other twelve could be
    // moved into the retry set silently, and a retried `session-closed` is a second Remove-VMSnapshot.
    //
    // Adding a sixteenth code now fails this test until someone decides which half it belongs to.
    // Note the name: MUST_NOT_RETRY, not "may have run". Two different grounds land a code here, and
    // conflating them is how a wrong classification would slip in.
    const MUST_NOT_RETRY: readonly HyperVWindowsSessionErrorCode[] = [
        // GROUND 1 — safety. The child may already have executed the request, so re-issuing could
        // apply a mutation twice. This is the group the never-ran set exists to exclude.
        "hyper-v-windows-session-timeout",
        "hyper-v-windows-session-exited",
        "hyper-v-windows-session-closed",
        "hyper-v-windows-session-pool-closed",
        // A reply arrived but could not be matched or trusted, so what ran is unknown.
        "hyper-v-windows-session-response-uncorrelated",
        "hyper-v-windows-session-response-invalid",
        "hyper-v-windows-session-response-too-large",

        // GROUND 2 — provably never ran, but re-issuing is still wrong. Both of these return before
        // any frame is written (powershell-session.ts:392 and :398/:404), so they are as safe to
        // retry as anything in the never-ran set. They are excluded for reasons that have nothing to
        // do with safety, and an earlier version of this comment got that wrong by claiming
        // cancellation "races the write" — it does not; the abort check runs before ensureChild.
        //
        // A cancelled request must not be re-issued because the caller asked for it to stop; a
        // one-shot fallback would run exactly what they cancelled.
        "hyper-v-windows-session-cancelled",
        // An oversized request is refused against a limit the one-shot path enforces too, so a
        // fallback fails identically while spending the caller's remaining budget to do it.
        "hyper-v-windows-session-request-too-large",
    ];

    it("classifies every session error code as either never-ran or must-not-retry", () => {
        const neverRan = [...SESSION_NEVER_RAN_ERRORS];
        const mustNotRetry = new Set<string>(MUST_NOT_RETRY);
        const both = neverRan.filter((code) => mustNotRetry.has(code));
        expect({ overlapping: both }).toEqual({ overlapping: [] });
        const classified = new Set([...neverRan, ...MUST_NOT_RETRY]);
        const unclassified = HYPER_V_WINDOWS_SESSION_ERROR_CODES.filter((code) => !classified.has(code));
        expect({ unclassified }).toEqual({ unclassified: [] });
        expect(classified.size).toBe(HYPER_V_WINDOWS_SESSION_ERROR_CODES.length);
    });

    it("never retries a failure that may already have run on the host", async () => {
        const run = vi.fn(async () => ({ status: 0, stdout: envelope([machine]) }));
        for (const error of MUST_NOT_RETRY) {
            run.mockClear();
            const client = createDeviceLabHyperVWindowsClient({
                executable: "powershell.exe",
                timeoutMilliseconds: 1000,
                run,
                session: sessionReturning({ status: null, stdout: "", error }),
            });
            // Re-issuing here could apply a mutation twice, so the transport error surfaces instead.
            await expect(client.getVM({ kind: "id", id: VM_ID })).rejects.toThrow(/hyper-v-windows-transport/);
            expect(run).not.toHaveBeenCalled();
        }
    });

    it("keeps the one-shot transport unchanged when no session is supplied", async () => {
        const run = vi.fn(async () => ({ status: 0, stdout: envelope([machine]) }));
        const client = createDeviceLabHyperVWindowsClient({
            executable: "powershell.exe",
            timeoutMilliseconds: 1000,
            run,
        });

        expect((await client.getVM({ kind: "id", id: VM_ID }))[0]?.id).toBe(VM_ID);
        expect(run).toHaveBeenCalledTimes(1);
    });

    it("produces identical results through either transport", async () => {
        const stdout = envelope([machine]);
        const request = { kind: "id", id: VM_ID } as const;
        const viaOneShot = await createDeviceLabHyperVWindowsClient({
            executable: "powershell.exe",
            timeoutMilliseconds: 1000,
            run: async () => ({ status: 0, stdout }),
        }).getVM(request);
        const viaSession = await createDeviceLabHyperVWindowsClient({
            executable: "powershell.exe",
            timeoutMilliseconds: 1000,
            run: vi.fn(),
            session: sessionReturning({ status: 0, stdout }),
        }).getVM(request);

        // If the two transports could diverge, every existing adapter test would prove less than it
        // appears to, because they all run the one-shot path.
        expect(viaSession).toEqual(viaOneShot);
    });

    it("produces identical native failures through either transport", async () => {
        // The parity test above compares a success envelope only, which is exactly why the asset's
        // `exit 1` on the failure path survived review: a native failure is the case where the two
        // transports could diverge, and it is the common case — every ownership check and every
        // reconcile exists to discover a VM that is not there.
        const stdout = JSON.stringify({
            schemaVersion: 1,
            operation: "Get-VM",
            ok: false,
            errorCode: "virtual-machine-not-found",
        });
        const request = { kind: "id", id: VM_ID } as const;
        // Compared on nativeStatus, not on message: the message is
        // hyper-v-windows-<category>:<operation>:<code> and never carries the exit status, so a
        // message comparison would pass unchanged with the session reporting 0 and the one-shot
        // reporting 1 — the exact divergence the exit-code plumbing exists to close.
        const failure = async (client: ReturnType<typeof createDeviceLabHyperVWindowsClient>) => {
            try {
                await client.getVM(request);
                return "no-error-thrown";
            } catch (error) {
                const typed = error as HyperVWindowsError;
                return `${typed.message}|status=${typed.nativeStatus}`;
            }
        };

        const viaOneShot = await failure(createDeviceLabHyperVWindowsClient({
            executable: "powershell.exe",
            timeoutMilliseconds: 1000,
            run: async () => ({ status: 1, stdout }),
        }));
        const viaSession = await failure(createDeviceLabHyperVWindowsClient({
            executable: "powershell.exe",
            timeoutMilliseconds: 1000,
            run: vi.fn(),
            session: sessionReturning({ status: 1, stdout }),
        }));

        expect(viaSession).toBe(viaOneShot);
        expect(viaSession).toBe("hyper-v-windows-native:Get-VM:virtual-machine-not-found|status=1");
    });

    it("bounds a session call by the caller's remaining deadline", async () => {
        // timeoutMilliseconds is passed as a function so each primitive is bounded by what is left
        // of the operation's budget. The one-shot branch applies that clamp; the session branch has
        // to as well, or a call with seconds left blocks for the library's full per-call ceiling.
        const seen: number[] = [];
        const client = createDeviceLabHyperVWindowsClient({
            executable: "powershell.exe",
            timeoutMilliseconds: () => 2500,
            run: vi.fn(),
            session: {
                execute: (_request, context) => {
                    seen.push(context.timeoutMilliseconds);
                    return { status: 0, stdout: envelope([machine]) };
                },
            },
        });

        await client.getVM({ kind: "id", id: VM_ID });
        expect(seen).toEqual([2500]);
    });

    it("records the session's execution, which never passes through the command runner", async () => {
        // The broker surfaces the raw provider execution in snapshot payloads via
        // redactProviderCommandInput. Recording only inside the wrapped runner left that permanently
        // null once a session was supplied, because the session serves every primitive and the
        // runner is then never called — so the payloads degraded to stubs exactly on the failures
        // operators need them for.
        const stdout = envelope([machine]);
        const recording = createRecordingDeviceLabHyperVWindowsClient({
            executable: "powershell.exe",
            timeoutMilliseconds: 1000,
            run: vi.fn(),
            session: sessionReturning({ status: 0, stdout }),
        });

        expect(recording.lastExecution()).toBeNull();
        await recording.client.getVM({ kind: "id", id: VM_ID });

        // Compared against the one-shot transport through the redactor the broker actually uses,
        // rather than pinning the session's own shape. Pinning one side is how this defect recurred
        // four times: each fix restored the keys it was told about (mode, provider) and left the
        // next ones (input -> inputConfigured, timedOut) diverging, with the test asserting the
        // divergence as if it were correct. Equality is the only assertion that cannot rot that way.
        const viaOneShot = createRecordingDeviceLabHyperVWindowsClient({
            executable: "powershell.exe",
            timeoutMilliseconds: 1000,
            run: async (command) => ({
                mode: command.mode,
                provider: command.provider,
                ...(command.input === undefined ? {} : { input: command.input }),
                status: 0,
                stdout,
            }),
        });
        await viaOneShot.client.getVM({ kind: "id", id: VM_ID });

        expect(redactProviderCommandInput(recording.lastExecution() as never, true))
            .toEqual(redactProviderCommandInput(viaOneShot.lastExecution() as never, true));
        expect(redactProviderCommandInput(recording.lastExecution() as never, true)).toEqual({
            mode: "exec",
            provider: "hyper-v",
            status: 0,
            stdoutPresent: true,
            stderrPresent: false,
            outputRedacted: true,
            inputConfigured: true,
        });
    });

    it("reports a session timeout the way a one-shot timeout is reported", async () => {
        // The failure payload is the one operators read, and timedOut is part of it. A session
        // timeout that omitted it made device_snapshot_* failures describable only by which
        // transport served them.
        const timedOutViaSession = createRecordingDeviceLabHyperVWindowsClient({
            executable: "powershell.exe",
            timeoutMilliseconds: 1000,
            run: vi.fn(),
            session: sessionReturning({ status: null, stdout: "", error: "hyper-v-windows-session-timeout" }),
        });
        const timedOutViaOneShot = createRecordingDeviceLabHyperVWindowsClient({
            executable: "powershell.exe",
            timeoutMilliseconds: 1000,
            run: async (command) => ({
                mode: command.mode,
                provider: command.provider,
                ...(command.input === undefined ? {} : { input: command.input }),
                status: null,
                stdout: "",
                timedOut: true,
                error: "timeout",
            }),
        });

        await expect(timedOutViaSession.client.getVM({ kind: "id", id: VM_ID })).rejects.toThrow();
        await expect(timedOutViaOneShot.client.getVM({ kind: "id", id: VM_ID })).rejects.toThrow();

        const session = redactProviderCommandInput(timedOutViaSession.lastExecution() as never, true);
        const oneShot = redactProviderCommandInput(timedOutViaOneShot.lastExecution() as never, true);
        expect(session.timedOut).toBe(true);
        expect(Object.keys(session).sort()).toEqual(Object.keys(oneShot).sort());
    });

    it("charges the one-shot retry for what the session already spent", async () => {
        // The session attempt and its retry together must stay inside the caller's deadline. A floor
        // of half the budget was measured overrunning it by 41%: a 1000ms caller whose session spent
        // 900ms still got 500ms for the retry.
        // The fixture has to separate three values, which a generous budget does not: with 4000ms
        // and 600ms spent, the old half-budget floor (2000) sits BELOW the true remainder (3400) and
        // never bites. 2000ms with 1200ms spent puts them on either side — remainder ~800, floor
        // 1000, no-subtraction 2000 — and stays above the 500ms guard, below which the retry is
        // suppressed entirely and this would measure nothing at all.
        const seen: number[] = [];
        const client = createDeviceLabHyperVWindowsClient({
            executable: "powershell.exe",
            timeoutMilliseconds: 2000,
            run: async (_command, options) => {
                seen.push(options.timeoutMs);
                return { status: 0, stdout: envelope([machine]) };
            },
            session: {
                execute: async () => {
                    await new Promise((resolve) => setTimeout(resolve, 1200));
                    return { status: null, stdout: "", error: "hyper-v-windows-session-unavailable" };
                },
            },
        });

        await client.getVM({ kind: "id", id: VM_ID });
        expect(seen).toHaveLength(1);
        expect(seen[0]).toBeGreaterThan(500);
        expect(seen[0]).toBeLessThan(900);
    });

    it("does not spawn a retry it has no time to run, but still records the failure", async () => {
        // Below a plausible Windows cold start a retry can only pay for a process and be killed on
        // arrival, while overrunning the caller's deadline to do it. Both halves matter: the missing
        // record would leave the snapshot payload reporting status 0 for a failed operation, and I
        // found that by reading rather than from a failing test.
        const run = vi.fn();
        const recorded: unknown[] = [];
        const client = createDeviceLabHyperVWindowsClient({
            executable: "powershell.exe",
            timeoutMilliseconds: 400,
            run,
            record: (result) => { recorded.push(result); },
            session: sessionReturning({ status: null, stdout: "", error: "hyper-v-windows-session-unavailable" }),
        });

        await expect(client.getVM({ kind: "id", id: VM_ID })).rejects.toThrow(/hyper-v-windows-transport/);
        expect(run).not.toHaveBeenCalled();
        expect(recorded).toHaveLength(1);
        expect(recorded[0]).toMatchObject({ mode: "exec", provider: "hyper-v" });
    });

    it("passes the caller's request through unchanged", async () => {
        const seen: HyperVWindowsExecutionRequest[] = [];
        const client = createDeviceLabHyperVWindowsClient({
            executable: "powershell.exe",
            timeoutMilliseconds: 1000,
            run: vi.fn(),
            session: {
                execute: (request) => {
                    seen.push(request);
                    return { status: 0, stdout: envelope([machine]) };
                },
            },
        });

        await client.getVM({ kind: "id", id: VM_ID });
        expect(seen).toEqual([{ schemaVersion: 1, operation: "Get-VM", selector: { kind: "id", id: VM_ID } }]);
    });
});
