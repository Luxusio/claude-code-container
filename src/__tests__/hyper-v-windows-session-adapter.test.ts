import { describe, expect, it, vi } from "vitest";

import { createDeviceLabHyperVWindowsClient } from "../device-lab/broker/hyper-v/lifecycle-adapter.js";
import type {
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

    it("never retries a failure that may already have run on the host", async () => {
        const run = vi.fn(async () => ({ status: 0, stdout: envelope([machine]) }));
        for (const error of [
            "hyper-v-windows-session-timeout",
            "hyper-v-windows-session-exited",
            "hyper-v-windows-session-response-uncorrelated",
        ]) {
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
        const failure = async (client: ReturnType<typeof createDeviceLabHyperVWindowsClient>) => {
            try {
                await client.getVM(request);
                return "no-error-thrown";
            } catch (error) {
                return (error as Error).message;
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
        expect(viaSession).toContain("virtual-machine-not-found");
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
