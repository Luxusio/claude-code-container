import { readFileSync } from "fs";
import { EventEmitter } from "events";
import { join } from "path";
import { pathToFileURL } from "url";
import { describe, expect, it, vi } from "vitest";

const childProcessMocks = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock("child_process", () => ({ spawn: childProcessMocks.spawn }));
vi.mock("../windows-system-powershell.js", async (importOriginal) => ({
    ...await importOriginal<typeof import("../windows-system-powershell.js")>(),
    canonicalWindowsPowerShellPath: () => "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
}));

import {
    HYPER_V_WINDOWS_OPERATIONS,
    HYPER_V_WINDOWS_SESSION_ERROR_CODES,
    HYPER_V_WINDOWS_SESSION_CLOSE_MARKER,
    HYPER_V_WINDOWS_SESSION_REQUEST_PREFIX,
    HYPER_V_WINDOWS_SESSION_RESPONSE_PREFIX,
    type HyperVWindowsExecutionRequest,
    type HyperVWindowsExecutionResult,
    type HyperVWindowsExecutor,
    type HyperVWindowsSessionErrorCode,
} from "../hyper-v-windows/index.js";
import {
    HYPER_V_ELEVATED_NETWORK_ERROR_CODES,
    HYPER_V_ELEVATED_NETWORK_RELAY_PROGRESS_STAGES,
    HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP,
    HYPER_V_ELEVATED_NETWORK_TERMINATION_STAGES,
    HyperVElevatedNetworkSessionError,
    getHyperVElevatedNetworkTerminationDiagnostic,
    getHyperVElevatedNetworkTerminationStage,
    transitionHyperVElevatedNetworkRelayFailure,
    withElevatedHyperVNetworkExecutor,
    type HyperVElevatedNetworkErrorCode,
    type HyperVElevatedNetworkRelayCompletion,
    type HyperVElevatedNetworkRelayProcess,
    type HyperVElevatedNetworkRelaySpawn,
    type HyperVElevatedNetworkTerminationStage,
} from "../device-lab/broker/hyper-v/elevated-network-session.js";

const executable = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const elevationClosePrefix = "CCC_HYPER_V_ELEVATED_NETWORK_CLOSE:";
const vmId = "11111111-2222-3333-4444-555555555555";

function getVmRequest(): HyperVWindowsExecutionRequest {
    return {
        schemaVersion: 1,
        operation: "Get-VM",
        selector: { kind: "id", id: vmId },
    };
}

function getVmSwitchRequest(): HyperVWindowsExecutionRequest {
    return {
        schemaVersion: 1,
        operation: "Get-VMSwitch",
        selector: { kind: "all" },
    };
}

function successEnvelope(operation: HyperVWindowsExecutionRequest["operation"]): string {
    return JSON.stringify({ schemaVersion: 1, operation, ok: true, items: [] });
}

type FakeRelay = {
    readonly process: HyperVElevatedNetworkRelayProcess;
    readonly requests: HyperVWindowsExecutionRequest[];
    readonly gracefullyClosed: () => boolean;
    readonly forceKilled: () => boolean;
    fail(code: HyperVElevatedNetworkErrorCode, reason?: HyperVWindowsSessionErrorCode): void;
};

function fakeRelay(): FakeRelay {
    const lineListeners: Array<(line: string) => void> = [];
    const exitListeners: Array<(reason: HyperVWindowsSessionErrorCode) => void> = [];
    const requests: HyperVWindowsExecutionRequest[] = [];
    let completionResult: HyperVElevatedNetworkRelayCompletion = {
        errorCode: null,
        terminationStage: null,
    };
    let closed = false;
    let graceful = false;
    let forced = false;
    let closeReason: HyperVWindowsSessionErrorCode = "hyper-v-windows-session-exited";
    let resolveCompletion = (_value: HyperVElevatedNetworkRelayCompletion) => undefined as void;
    const completion = new Promise<HyperVElevatedNetworkRelayCompletion>((resolve) => {
        resolveCompletion = resolve;
    });
    const close = () => {
        if (closed) return;
        closed = true;
        resolveCompletion(completionResult);
    };
    return {
        requests,
        gracefullyClosed: () => graceful,
        forceKilled: () => forced,
        process: {
            completion,
            failureCode: () => completionResult.errorCode,
            diagnostic: () => ({
                shutdownMode: graceful ? "graceful" : forced ? "abrupt" : "not-started",
                progressStage: null,
                closeWriteStatus: graceful ? "succeeded" : "not-started",
                processExited: closed,
                stdoutDrained: closed,
                stderrObserved: false,
                forceExpired: forced,
            }),
            write(line, settled) {
                if (closed) {
                    settled?.(new Error("closed"));
                    return;
                }
                settled?.();
                if (!line.startsWith(HYPER_V_WINDOWS_SESSION_REQUEST_PREFIX)) return;
                const encoded = line.slice(HYPER_V_WINDOWS_SESSION_REQUEST_PREFIX.length);
                const frame: unknown = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
                if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw new Error("invalid test frame");
                const id = Reflect.get(frame, "id");
                const input = Reflect.get(frame, "input");
                if (typeof id !== "string" || typeof input !== "string") throw new Error("invalid test frame");
                const request: unknown = JSON.parse(input);
                if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("invalid test request");
                const operation = Reflect.get(request, "operation");
                if (operation !== "Get-VM") throw new Error("unexpected test operation");
                const typedRequest = getVmRequest();
                requests.push(typedRequest);
                const reply = Buffer.from(JSON.stringify({
                    id,
                    code: 0,
                    stdout: successEnvelope(typedRequest.operation),
                }), "utf8").toString("base64");
                queueMicrotask(() => {
                    for (const listener of [...lineListeners]) {
                        listener(`${HYPER_V_WINDOWS_SESSION_RESPONSE_PREFIX}${reply}`);
                    }
                });
            },
            onLine(listener) {
                lineListeners.push(listener);
            },
            onExit(listener) {
                exitListeners.push(listener);
                if (closed) queueMicrotask(() => listener(closeReason));
            },
            close() {
                graceful = true;
                close();
            },
            kill() {
                forced = true;
                close();
            },
        },
        fail(code, reason = "hyper-v-windows-session-exited") {
            completionResult = code === "hyper-v-network-elevation-termination-unconfirmed"
                ? { errorCode: code, terminationStage: "elevated-child" }
                : { errorCode: code, terminationStage: null };
            closeReason = reason;
            for (const listener of [...exitListeners]) listener(reason);
            close();
        },
    };
}

function executorContext() {
    return { timeoutMilliseconds: 5_000, maximumOutputBytes: 64 * 1024 } as const;
}

describe("callback-scoped elevated Hyper-V network session", () => {
    it("requests elevation once and serves multiple individually correlated requests", async () => {
        const beforeElevation = vi.fn();
        const relay = fakeRelay();
        const spawnRelay: HyperVElevatedNetworkRelaySpawn = vi.fn(async (request) => {
            expect(request.sessionBootstrap).toContain(HYPER_V_WINDOWS_SESSION_REQUEST_PREFIX);
            expect(request.sessionBootstrap).toContain(HYPER_V_WINDOWS_SESSION_CLOSE_MARKER);
            request.onBeforeElevation();
            return relay.process;
        });

        const result = await withElevatedHyperVNetworkExecutor({
            executable,
            deadlineUnixMilliseconds: Date.now() + 30_000,
            onBeforeElevation: beforeElevation,
            spawnRelay,
        }, async (executor) => [
            await executor.execute(getVmRequest(), executorContext()),
            await executor.execute(getVmRequest(), executorContext()),
        ]);

        expect(result).toEqual([
            { status: 0, stdout: successEnvelope("Get-VM") },
            { status: 0, stdout: successEnvelope("Get-VM") },
        ]);
        expect(spawnRelay).toHaveBeenCalledTimes(1);
        expect(beforeElevation).toHaveBeenCalledTimes(1);
        expect(relay.requests).toHaveLength(2);
        expect(relay.gracefullyClosed()).toBe(true);
        expect(relay.forceKilled()).toBe(false);
    });

    it("does not request UAC when the callback performs no administrator operation", async () => {
        const spawnRelay = vi.fn<HyperVElevatedNetworkRelaySpawn>();
        const beforeElevation = vi.fn();

        await expect(withElevatedHyperVNetworkExecutor({
            executable,
            deadlineUnixMilliseconds: Date.now() + 30_000,
            onBeforeElevation: beforeElevation,
            spawnRelay,
        }, async () => "no-op")).resolves.toBe("no-op");

        expect(spawnRelay).not.toHaveBeenCalled();
        expect(beforeElevation).not.toHaveBeenCalled();
    });

    it("invalidates an executor that a callback attempts to retain", async () => {
        const relay = fakeRelay();
        const leaked = await withElevatedHyperVNetworkExecutor({
            executable,
            deadlineUnixMilliseconds: Date.now() + 30_000,
            spawnRelay: async (request) => {
                request.onBeforeElevation();
                return relay.process;
            },
        }, async (executor) => {
            await executor.execute(getVmRequest(), executorContext());
            return executor;
        });

        await expect(leaked.execute(getVmRequest(), executorContext())).resolves.toEqual({
            status: null,
            stdout: "",
            error: "hyper-v-network-elevation-scope-closed",
        });
        expect(relay.requests).toHaveLength(1);
    });

    it("maps launch and consent failures to bounded elevation codes", async () => {
        const spawnRelay: HyperVElevatedNetworkRelaySpawn = async () => {
            throw new HyperVElevatedNetworkSessionError("hyper-v-network-elevation-cancelled");
        };

        const result = await withElevatedHyperVNetworkExecutor({
            executable,
            deadlineUnixMilliseconds: Date.now() + 30_000,
            spawnRelay,
        }, (executor) => executor.execute(getVmRequest(), executorContext()));

        expect(result).toMatchObject({
            status: null,
            error: "hyper-v-network-elevation-cancelled",
        });
    });

    it("returns relay failures without exposing relay output", async () => {
        const relay = fakeRelay();
        const result = await withElevatedHyperVNetworkExecutor({
            executable,
            deadlineUnixMilliseconds: Date.now() + 30_000,
            spawnRelay: async (request) => {
                request.onBeforeElevation();
                queueMicrotask(() => relay.fail("hyper-v-network-elevation-authentication-failed"));
                return relay.process;
            },
        }, (executor) => executor.execute(getVmRequest(), executorContext()));

        expect(result).toMatchObject({
            status: null,
            error: "hyper-v-network-elevation-authentication-failed",
        });
        expect(JSON.stringify(result)).not.toContain("AUTH:");
    });

    it.each([
        "hyper-v-network-elevation-handshake-timeout",
        "hyper-v-network-elevation-administrator-required",
        "hyper-v-network-elevation-deadline-exceeded",
        "hyper-v-network-elevation-relay-failed",
    ] satisfies HyperVElevatedNetworkErrorCode[])("preserves the bounded relay failure %s", async (code) => {
        const relay = fakeRelay();
        const result = await withElevatedHyperVNetworkExecutor({
            executable,
            deadlineUnixMilliseconds: Date.now() + 30_000,
            spawnRelay: async (request) => {
                request.onBeforeElevation();
                queueMicrotask(() => relay.fail(code));
                return relay.process;
            },
        }, (executor) => executor.execute(getVmRequest(), executorContext()));

        expect(result).toEqual({ status: null, stdout: "", error: code });
    });

    it("honors pre-aborted cancellation without spawning or prompting", async () => {
        const controller = new AbortController();
        controller.abort();
        const spawnRelay = vi.fn<HyperVElevatedNetworkRelaySpawn>();
        const beforeElevation = vi.fn();

        const result = await withElevatedHyperVNetworkExecutor({
            executable,
            deadlineUnixMilliseconds: Date.now() + 30_000,
            signal: controller.signal,
            onBeforeElevation: beforeElevation,
            spawnRelay,
        }, (executor) => executor.execute(getVmRequest(), executorContext()));

        expect(result.error).toBe("hyper-v-network-elevation-cancelled");
        expect(spawnRelay).not.toHaveBeenCalled();
        expect(beforeElevation).not.toHaveBeenCalled();
    });

    it.each([
        "elevated-child",
        "relay-terminal-ack-missing",
        "relay-process-exit-timeout",
        "relay-output-drain-timeout",
        "relay-input-write",
    ] satisfies Exclude<HyperVElevatedNetworkTerminationStage, "relay-completion-timeout">[])(
        "fails a successful callback when termination is unconfirmed at %s",
        async (terminationStage) => {
            const relay = fakeRelay();
            const originalKill = relay.process.kill;
            const process: HyperVElevatedNetworkRelayProcess = {
                ...relay.process,
                completion: Promise.resolve({
                    errorCode: "hyper-v-network-elevation-termination-unconfirmed",
                    terminationStage,
                }),
                kill: originalKill,
            };

            await expect(withElevatedHyperVNetworkExecutor({
                executable,
                deadlineUnixMilliseconds: Date.now() + 30_000,
                spawnRelay: async (request) => {
                    request.onBeforeElevation();
                    return process;
                },
            }, (executor) => executor.execute(getVmRequest(), executorContext()))).rejects.toMatchObject({
                code: "hyper-v-network-elevation-termination-unconfirmed",
                message: "hyper-v-network-elevation-termination-unconfirmed",
                terminationStage,
            });
        },
    );

    it("rejects a successful callback when relay completion carries a primary failure", async () => {
        const relay = fakeRelay();
        const process: HyperVElevatedNetworkRelayProcess = {
            ...relay.process,
            completion: Promise.resolve({
                errorCode: "hyper-v-network-elevation-relay-failed",
                terminationStage: null,
            }),
        };

        await expect(withElevatedHyperVNetworkExecutor({
            executable,
            deadlineUnixMilliseconds: Date.now() + 30_000,
            spawnRelay: async (request) => {
                request.onBeforeElevation();
                return process;
            },
        }, (executor) => executor.execute(getVmRequest(), executorContext()))).rejects.toMatchObject({
            code: "hyper-v-network-elevation-relay-failed",
        });
    });

    it("does not accept an arbitrary callback error property as a surfaced execution failure", async () => {
        const relay = fakeRelay();
        const process: HyperVElevatedNetworkRelayProcess = {
            ...relay.process,
            completion: Promise.resolve({
                errorCode: "hyper-v-network-elevation-relay-failed",
                terminationStage: null,
            }),
        };

        await expect(withElevatedHyperVNetworkExecutor({
            executable,
            deadlineUnixMilliseconds: Date.now() + 30_000,
            spawnRelay: async (request) => {
                request.onBeforeElevation();
                return process;
            },
        }, async (executor) => {
            await executor.execute(getVmRequest(), executorContext());
            return { error: "hyper-v-network-elevation-relay-failed" };
        })).rejects.toMatchObject({ code: "hyper-v-network-elevation-relay-failed" });
    });

    it("preserves a thrown callback failure when relay completion also has a primary failure", async () => {
        const callbackFailure = new Error("callback-failed");
        const relay = fakeRelay();
        const process: HyperVElevatedNetworkRelayProcess = {
            ...relay.process,
            completion: Promise.resolve({
                errorCode: "hyper-v-network-elevation-relay-failed",
                terminationStage: null,
            }),
        };

        await expect(withElevatedHyperVNetworkExecutor({
            executable,
            deadlineUnixMilliseconds: Date.now() + 30_000,
            spawnRelay: async (request) => {
                request.onBeforeElevation();
                return process;
            },
        }, async (executor) => {
            await executor.execute(getVmRequest(), executorContext());
            throw callbackFailure;
        })).rejects.toBe(callbackFailure);
    });

    it("lets relay completion settle after its force window and before the wrapper timeout", async () => {
        vi.useFakeTimers();
        try {
            const relay = fakeRelay();
            let resolveCompletion = (_value: HyperVElevatedNetworkRelayCompletion) => undefined as void;
            const completion = new Promise<HyperVElevatedNetworkRelayCompletion>((resolve) => {
                resolveCompletion = resolve;
            });
            const process: HyperVElevatedNetworkRelayProcess = {
                ...relay.process,
                completion,
                close() {
                    setTimeout(() => resolveCompletion({ errorCode: null, terminationStage: null }), 10_001);
                },
            };

            const result = withElevatedHyperVNetworkExecutor({
                executable,
                deadlineUnixMilliseconds: Date.now() + 30_000,
                spawnRelay: async (request) => {
                    request.onBeforeElevation();
                    return process;
                },
            }, (executor) => executor.execute(getVmRequest(), executorContext()));

            await vi.advanceTimersByTimeAsync(10_001);
            await expect(result).resolves.toEqual({ status: 0, stdout: successEnvelope("Get-VM") });
        } finally {
            vi.useRealTimers();
        }
    });

    it("retains the first session failure when queued work forces abrupt shutdown", async () => {
        vi.useFakeTimers();
        try {
            let resolveCompletion = (_value: HyperVElevatedNetworkRelayCompletion) => undefined as void;
            const completion = new Promise<HyperVElevatedNetworkRelayCompletion>((resolve) => {
                resolveCompletion = resolve;
            });
            const lineListeners: Array<(line: string) => void> = [];
            const exitListeners: Array<(reason: HyperVWindowsSessionErrorCode) => void> = [];
            let killed = false;
            const process: HyperVElevatedNetworkRelayProcess = {
                completion,
                failureCode: () => null,
                diagnostic: () => ({
                    shutdownMode: killed ? "abrupt" : "not-started",
                    progressStage: "request-forwarded",
                    closeWriteStatus: "not-started",
                    processExited: killed,
                    stdoutDrained: killed,
                    stderrObserved: false,
                    forceExpired: killed,
                }),
                write(_line, settled) {
                    settled?.();
                },
                onLine(listener) {
                    lineListeners.push(listener);
                },
                onExit(listener) {
                    exitListeners.push(listener);
                },
                close() {
                    throw new Error("queued work must not close gracefully");
                },
                kill() {
                    killed = true;
                    resolveCompletion({
                        errorCode: "hyper-v-network-elevation-termination-unconfirmed",
                        terminationStage: "relay-terminal-ack-missing",
                    });
                },
            };

            const result = withElevatedHyperVNetworkExecutor({
                executable,
                deadlineUnixMilliseconds: Date.now() + 30_000,
                spawnRelay: async (request) => {
                    request.onBeforeElevation();
                    return process;
                },
            }, async (executor) => {
                void executor.execute(getVmRequest(), executorContext());
                const queued = await executor.execute(getVmSwitchRequest(), executorContext());
                if (queued.error) throw new Error(queued.error);
                return queued;
            });
            const settled = result.then(() => null, (error: unknown) => error);

            await vi.advanceTimersByTimeAsync(1_251);
            expect(await settled).toMatchObject({
                code: "hyper-v-network-elevation-termination-unconfirmed",
                terminationStage: "relay-terminal-ack-missing",
                terminationDiagnostic: {
                    relay: {
                        shutdownMode: "abrupt",
                        progressStage: "request-forwarded",
                        closeWriteStatus: "not-started",
                    },
                    execution: {
                        lastOperation: "Get-VMSwitch",
                        lastSessionError: "hyper-v-windows-session-queue-timeout",
                        activeExecutions: 1,
                        pendingExecutions: 1,
                    },
                },
            });
            expect(killed).toBe(true);
            expect(lineListeners).toHaveLength(1);
            expect(exitListeners).toHaveLength(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it("separates caller-active work from a delivered request still pending at scope close", async () => {
        vi.useFakeTimers();
        try {
            let resolveCompletion = (_value: HyperVElevatedNetworkRelayCompletion) => undefined as void;
            const completion = new Promise<HyperVElevatedNetworkRelayCompletion>((resolve) => {
                resolveCompletion = resolve;
            });
            let killed = false;
            const process: HyperVElevatedNetworkRelayProcess = {
                completion,
                failureCode: () => null,
                diagnostic: () => ({
                    shutdownMode: killed ? "abrupt" : "not-started",
                    progressStage: "request-forwarded",
                    closeWriteStatus: "not-started",
                    processExited: killed,
                    stdoutDrained: killed,
                    stderrObserved: false,
                    forceExpired: killed,
                }),
                write(_line, settled) {
                    settled?.();
                },
                onLine() {},
                onExit() {},
                close() {
                    throw new Error("pending delivered work must not close gracefully");
                },
                kill() {
                    killed = true;
                    resolveCompletion({
                        errorCode: "hyper-v-network-elevation-termination-unconfirmed",
                        terminationStage: "relay-terminal-ack-missing",
                    });
                },
            };

            const result = withElevatedHyperVNetworkExecutor({
                executable,
                deadlineUnixMilliseconds: Date.now() + 30_000,
                spawnRelay: async (request) => {
                    request.onBeforeElevation();
                    return process;
                },
            }, async (executor) => {
                const timedOut = await executor.execute(getVmRequest(), {
                    timeoutMilliseconds: 100,
                    maximumOutputBytes: 64 * 1024,
                });
                if (timedOut.error) throw new Error(timedOut.error);
                return timedOut;
            });
            const settled = result.then(() => null, (error: unknown) => error);

            await vi.advanceTimersByTimeAsync(0);
            await vi.advanceTimersByTimeAsync(100);
            expect(await settled).toMatchObject({
                code: "hyper-v-network-elevation-termination-unconfirmed",
                terminationDiagnostic: {
                    execution: {
                        lastOperation: "Get-VM",
                        lastSessionError: "hyper-v-windows-session-timeout",
                        activeExecutions: 0,
                        pendingExecutions: 1,
                    },
                },
            });
            expect(killed).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it("excludes an explicitly undelivered request from the scope-close pending count", async () => {
        vi.useFakeTimers();
        try {
            let resolveCompletion = (_value: HyperVElevatedNetworkRelayCompletion) => undefined as void;
            const completion = new Promise<HyperVElevatedNetworkRelayCompletion>((resolve) => {
                resolveCompletion = resolve;
            });
            let killed = false;
            const process: HyperVElevatedNetworkRelayProcess = {
                completion,
                failureCode: () => null,
                diagnostic: () => ({
                    shutdownMode: killed ? "abrupt" : "not-started",
                    progressStage: "request-forwarded",
                    closeWriteStatus: "not-started",
                    processExited: killed,
                    stdoutDrained: killed,
                    stderrObserved: false,
                    forceExpired: killed,
                }),
                write(_line, settled) {
                    settled?.(new Error("simulated request non-delivery"));
                },
                onLine() {},
                onExit() {},
                close() {
                    throw new Error("unsettled work must not close gracefully");
                },
                kill() {
                    killed = true;
                    resolveCompletion({
                        errorCode: "hyper-v-network-elevation-termination-unconfirmed",
                        terminationStage: "relay-terminal-ack-missing",
                    });
                },
            };

            const result = withElevatedHyperVNetworkExecutor({
                executable,
                deadlineUnixMilliseconds: Date.now() + 30_000,
                spawnRelay: async (request) => {
                    request.onBeforeElevation();
                    return process;
                },
            }, async (executor) => {
                const timedOut = await executor.execute(getVmRequest(), {
                    timeoutMilliseconds: 100,
                    maximumOutputBytes: 64 * 1024,
                });
                if (timedOut.error) throw new Error(timedOut.error);
                return timedOut;
            });
            const settled = result.then(() => null, (error: unknown) => error);

            await vi.advanceTimersByTimeAsync(100);
            expect(await settled).toMatchObject({
                code: "hyper-v-network-elevation-termination-unconfirmed",
                terminationDiagnostic: {
                    execution: {
                        lastOperation: "Get-VM",
                        lastSessionError: "hyper-v-windows-session-timeout",
                        activeExecutions: 0,
                        pendingExecutions: 0,
                    },
                },
            });
            expect(killed).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it.each(["cancelled", "deadline"] as const)(
        "records an admitted %s call as the last known operation",
        async (earlyOutcome) => {
            const relay = fakeRelay();
            const start = Date.now();
            const clock = vi.spyOn(Date, "now").mockReturnValue(start);
            const deadline = start + 1_000;
            const controller = new AbortController();
            const process: HyperVElevatedNetworkRelayProcess = {
                ...relay.process,
                completion: Promise.resolve({
                    errorCode: "hyper-v-network-elevation-termination-unconfirmed",
                    terminationStage: "relay-terminal-ack-missing",
                }),
            };
            try {
                const result = withElevatedHyperVNetworkExecutor({
                    executable,
                    deadlineUnixMilliseconds: deadline,
                    spawnRelay: async (request) => {
                        request.onBeforeElevation();
                        return process;
                    },
                }, async (executor) => {
                    expect(await executor.execute(getVmRequest(), executorContext())).toMatchObject({ status: 0 });
                    if (earlyOutcome === "cancelled") controller.abort();
                    else clock.mockReturnValue(deadline + 1);
                    return executor.execute(getVmSwitchRequest(), {
                        ...executorContext(),
                        signal: controller.signal,
                    });
                });

                await expect(result).rejects.toMatchObject({
                    code: "hyper-v-network-elevation-termination-unconfirmed",
                    terminationDiagnostic: {
                        execution: {
                            lastOperation: "Get-VMSwitch",
                            lastSessionError: null,
                            activeExecutions: 0,
                            pendingExecutions: 0,
                        },
                    },
                });
            } finally {
                clock.mockRestore();
            }
        },
    );

    it.each([
        "ack-before-exit",
        "ack-after-stdin-eof",
        "exit-before-ack",
        "invalid-ack",
        "duplicate-ack",
        "exit-before-duplicate-ack",
        "exit-before-truncated-duplicate-ack",
        "truncated-invalid-ack",
        "truncated-short-prefix",
        "exit-before-ack-with-extra-line",
        "premature-ack",
        "wrong-token-progress",
        "wrong-token-progress-followed-by-control",
        "unknown-progress-stage",
        "protocol-failure-followed-by-control",
        "elevated-child-failure-followed-by-control",
        "request-write-error-before-exit",
        "abrupt-stdin-error-truncated-eof",
        "graceful-force-timeout",
        "exit-before-force-late-child-failure",
        "force-before-exit-late-child-failure",
        "exit-and-stdout-before-force-no-close",
        "exit-stdin-error-late-child-failure",
        "ack-exit-wrapper-output-drain-timeout",
        "close-write-timeout",
        "close-write-timeout-delayed-success",
        "close-write-timeout-delayed-error",
        "ack-close-without-exit",
        "ack-exit-close-without-stdout-end",
        "ack-stdin-error",
    ] as const)(
        "handles correlated relay terminal protocol (%s) without depending on close for success",
        async (order) => {
            const usesAbruptForceTimer = order === "abrupt-stdin-error-truncated-eof";
            const usesInvalidProgress = order === "wrong-token-progress"
                || order === "wrong-token-progress-followed-by-control"
                || order === "unknown-progress-stage";
            const usesAbsorbingFailure = order === "protocol-failure-followed-by-control"
                || order === "elevated-child-failure-followed-by-control";
            const usesRequestWriteError = order === "request-write-error-before-exit";
            const usesLateForceOrdering = order === "exit-before-force-late-child-failure"
                || order === "force-before-exit-late-child-failure";
            const usesPreForceEvidence = order === "exit-and-stdout-before-force-no-close"
                || order === "exit-stdin-error-late-child-failure";
            const usesWrapperOutputDrain = order === "ack-exit-wrapper-output-drain-timeout";
            const usesForceTimer = usesAbruptForceTimer
                || order === "graceful-force-timeout"
                || usesLateForceOrdering
                || usesPreForceEvidence
                || usesInvalidProgress
                || usesAbsorbingFailure
                || usesRequestWriteError
                || usesWrapperOutputDrain;
            const forceKillsProcess = usesAbruptForceTimer
                || order === "graceful-force-timeout"
                || order === "force-before-exit-late-child-failure";
            const forceKillsRelay = forceKillsProcess
                || usesInvalidProgress
                || usesAbsorbingFailure
                || usesRequestWriteError;
            const autoCompletesForceProcess = forceKillsRelay && !usesLateForceOrdering;
            const usesCloseWriteTimer = order === "close-write-timeout"
                || order === "close-write-timeout-delayed-success"
                || order === "close-write-timeout-delayed-error";
            const usesFakeTimers = usesForceTimer || usesCloseWriteTimer;
            if (usesFakeTimers) vi.useFakeTimers();
            const events = new EventEmitter();
            const stdoutEvents = new EventEmitter();
            const stderr = new EventEmitter();
            const stdout = Object.assign(stdoutEvents, { setEncoding: () => stdout });
            const kill = vi.fn(() => {
                if (autoCompletesForceProcess) {
                    if (usesAbruptForceTimer) stdout.emit("data", "CCC_HYPER_V_ELEVATED_");
                    events.emit("exit", 1, null);
                    stdout.emit("end");
                    events.emit("close", 1, null);
                }
                return true;
            });
            let input = "";
            let terminalToken = "";
            let launchObserved = false;
            let closeObserved = false;
            let stdinEndedAfterCloseWrite = false;
            let stdinEndCalls = 0;
            let completeAfterStdinEnd: (() => void) | null = null;
            let closeWriteSettled: ((error?: Error) => void) | null = null;
            let deferredInvalidProgressResponse = "";
            let simulationError: unknown = null;

            const acceptInput = (chunk: string) => {
                input += chunk;
                let index = input.indexOf("\n");
                while (index >= 0) {
                    const line = input.slice(0, index);
                    input = input.slice(index + 1);
                    if (!launchObserved) {
                        const envelope: unknown = JSON.parse(Buffer.from(line, "base64").toString("utf8"));
                        if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
                            throw new Error("invalid launch envelope");
                        }
                        const observedToken = Reflect.get(envelope, "terminalToken");
                        if (typeof observedToken !== "string") throw new Error("missing terminal token");
                        terminalToken = observedToken;
                        launchObserved = true;
                        queueMicrotask(() => stdout.emit("data", "CCC_HYPER_V_ELEVATED_NETWORK_REQUEST\n"));
                    } else if (line === "CCC_HYPER_V_ELEVATED_NETWORK_APPROVE") {
                        queueMicrotask(() => {
                            if (order === "premature-ack") {
                                stdout.emit(
                                    "data",
                                    `CCC_HYPER_V_ELEVATED_NETWORK_TERMINAL:${terminalToken}\n`,
                                );
                                stdout.emit("end");
                                events.emit("exit", 1, null);
                                events.emit("close", 1, null);
                                return;
                            }
                            if (usesInvalidProgress) {
                                stdout.emit("data", "CCC_HYPER_V_ELEVATED_NETWORK_RELAY_READY\n");
                            }
                            const differentToken = terminalToken.startsWith("0")
                                ? `1${terminalToken.slice(1)}`
                                : `0${terminalToken.slice(1)}`;
                            const progressLine = order === "wrong-token-progress"
                                || order === "wrong-token-progress-followed-by-control"
                                ? `CCC_HYPER_V_ELEVATED_NETWORK_PROGRESS:${differentToken}:relay-ready\n`
                                : order === "unknown-progress-stage"
                                    ? `CCC_HYPER_V_ELEVATED_NETWORK_PROGRESS:${terminalToken}:native-secret\n`
                                    : `CCC_HYPER_V_ELEVATED_NETWORK_PROGRESS:${terminalToken}:relay-ready\n`;
                            const postRejectionControlLines = order === "wrong-token-progress-followed-by-control"
                                ? `CCC_HYPER_V_ELEVATED_NETWORK_PROGRESS:${terminalToken}:finalizer-entered\n`
                                    + "CCC_HYPER_V_ELEVATED_NETWORK_FAILURE:"
                                    + "hyper-v-network-elevation-termination-unconfirmed\n"
                                : "";
                            const absorbingFailureLines = order === "protocol-failure-followed-by-control"
                                ? "CCC_HYPER_V_ELEVATED_NETWORK_FAILURE:"
                                    + "hyper-v-network-elevation-protocol-invalid\n"
                                    + `CCC_HYPER_V_ELEVATED_NETWORK_PROGRESS:${terminalToken}:finalizer-entered\n`
                                    + "CCC_HYPER_V_ELEVATED_NETWORK_FAILURE:"
                                    + "hyper-v-network-elevation-termination-unconfirmed\n"
                                : order === "elevated-child-failure-followed-by-control"
                                    ? "CCC_HYPER_V_ELEVATED_NETWORK_FAILURE:"
                                        + "hyper-v-network-elevation-termination-unconfirmed\n"
                                        + `CCC_HYPER_V_ELEVATED_NETWORK_PROGRESS:${terminalToken}:finalizer-entered\n`
                                        + "CCC_HYPER_V_ELEVATED_NETWORK_FAILURE:"
                                        + "hyper-v-network-elevation-protocol-invalid\n"
                                    : "";
                            stdout.emit(
                                "data",
                                (usesInvalidProgress ? "" : "CCC_HYPER_V_ELEVATED_NETWORK_RELAY_READY\n")
                                + progressLine
                                + postRejectionControlLines
                                + absorbingFailureLines
                                + deferredInvalidProgressResponse,
                            );
                        });
                    } else if (line.startsWith(HYPER_V_WINDOWS_SESSION_REQUEST_PREFIX)) {
                        const encoded = line.slice(HYPER_V_WINDOWS_SESSION_REQUEST_PREFIX.length);
                        const frame: unknown = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
                        if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
                            throw new Error("invalid request frame");
                        }
                        const id = Reflect.get(frame, "id");
                        if (typeof id !== "string") throw new Error("missing request id");
                        const reply = Buffer.from(JSON.stringify({
                            id,
                            code: 0,
                            stdout: successEnvelope("Get-VM"),
                        }), "utf8").toString("base64");
                        const responseLine = `${HYPER_V_WINDOWS_SESSION_RESPONSE_PREFIX}${reply}\n`;
                        if (usesInvalidProgress) deferredInvalidProgressResponse = responseLine;
                        else queueMicrotask(() => {
                            stdout.emit("data", responseLine);
                            if (usesAbruptForceTimer) {
                                stdinEvents.emit("error", new Error("simulated abrupt stdin failure"));
                            }
                        });
                    } else if (line.startsWith(`${elevationClosePrefix}${terminalToken}:`)) {
                        const closeDeadline = line.slice(`${elevationClosePrefix}${terminalToken}:`.length);
                        expect(closeDeadline).toMatch(/^[0-9]{13}$/);
                        expect(Number(closeDeadline)).toBeGreaterThanOrEqual(Date.now());
                        expect(Number(closeDeadline)).toBeLessThanOrEqual(Date.now() + 5_000);
                        closeObserved = true;
                        expect(stdinEndedAfterCloseWrite).toBe(false);
                        const completeRelay = () => {
                            if (order === "ack-close-without-exit"
                                || order === "ack-exit-close-without-stdout-end") {
                                stdout.emit(
                                    "data",
                                    `CCC_HYPER_V_ELEVATED_NETWORK_PROGRESS:${terminalToken}:finalizer-entered\n`
                                    + `CCC_HYPER_V_ELEVATED_NETWORK_PROGRESS:${terminalToken}:terminal-write-entered\n`,
                                );
                            }
                            if (order === "invalid-ack") {
                                stdout.emit("data", "CCC_HYPER_V_ELEVATED_NETWORK_TERMINAL:invalid\n");
                                stdout.emit("end");
                                events.emit("exit", 1, null);
                                events.emit("close", 1, null);
                                return;
                            }
                            if (order === "truncated-invalid-ack") {
                                stdout.emit("data", "CCC_HYPER_V_ELEVATED_NETWORK_TERMINAL:invalid");
                                events.emit("exit", 1, null);
                                stdout.emit("end");
                                events.emit("close", 1, null);
                                return;
                            }
                            if (order === "truncated-short-prefix") {
                                stdout.emit("data", "CCC_HYPER_V_ELEVATED_");
                                events.emit("exit", 1, null);
                                stdout.emit("end");
                                events.emit("close", 1, null);
                                return;
                            }
                            if (order === "exit-before-force-late-child-failure") {
                                events.emit("exit", 1, null);
                                return;
                            }
                            if (order === "exit-and-stdout-before-force-no-close") {
                                events.emit("exit", 1, null);
                                stdout.emit("end");
                                return;
                            }
                            if (order === "exit-stdin-error-late-child-failure") {
                                events.emit("exit", 1, null);
                                stdinEvents.emit("error", new Error("simulated late stdin error"));
                                queueMicrotask(() => {
                                    stdout.emit(
                                        "data",
                                        "CCC_HYPER_V_ELEVATED_NETWORK_FAILURE:"
                                        + "hyper-v-network-elevation-termination-unconfirmed\n",
                                    );
                                    stdout.emit("end");
                                });
                                return;
                            }
                            const acknowledge = () => {
                                expect(stdinEndedAfterCloseWrite).toBe(true);
                                stdout.emit(
                                    "data",
                                    `CCC_HYPER_V_ELEVATED_NETWORK_TERMINAL:${terminalToken}\n`,
                                );
                            };
                            if (order === "ack-exit-wrapper-output-drain-timeout") {
                                acknowledge();
                                events.emit("exit", 0, null);
                                return;
                            }
                            if (order === "ack-close-without-exit") {
                                acknowledge();
                                stdout.emit("end");
                                events.emit("close", 0, null);
                            } else if (order === "ack-exit-close-without-stdout-end") {
                                acknowledge();
                                events.emit("exit", 0, null);
                                events.emit("close", 0, null);
                            } else if (order === "exit-before-duplicate-ack") {
                                events.emit("exit", 0, null);
                                stdout.emit(
                                    "data",
                                    `CCC_HYPER_V_ELEVATED_NETWORK_TERMINAL:${terminalToken}\n`
                                    + `CCC_HYPER_V_ELEVATED_NETWORK_TERMINAL:${terminalToken}\n`,
                                );
                                stdout.emit("end");
                            } else if (order === "exit-before-truncated-duplicate-ack") {
                                events.emit("exit", 0, null);
                                stdout.emit(
                                    "data",
                                    `CCC_HYPER_V_ELEVATED_NETWORK_TERMINAL:${terminalToken}\n`
                                    + `CCC_HYPER_V_ELEVATED_NETWORK_TERMINAL:${terminalToken}`,
                                );
                                stdout.emit("end");
                            } else if (order === "exit-before-ack-with-extra-line") {
                                events.emit("exit", 0, null);
                                stdout.emit(
                                    "data",
                                    `CCC_HYPER_V_ELEVATED_NETWORK_TERMINAL:${terminalToken}\n`
                                    + "unexpected-after-terminal\n",
                                );
                                stdout.emit("end");
                            } else if (order === "ack-before-exit"
                                || order === "ack-stdin-error"
                                || order === "duplicate-ack") {
                                acknowledge();
                                if (order === "duplicate-ack") acknowledge();
                                stdout.emit("end");
                                events.emit("exit", 0, null);
                            } else {
                                events.emit("exit", 0, null);
                                acknowledge();
                                stdout.emit("end");
                            }
                        };
                        if (order === "ack-after-stdin-eof") completeAfterStdinEnd = completeRelay;
                        else if (order !== "graceful-force-timeout"
                            && order !== "force-before-exit-late-child-failure") {
                            queueMicrotask(completeRelay);
                        }
                    }
                    index = input.indexOf("\n");
                }
            };
            const stdinEvents = new EventEmitter();
            const stdin = Object.assign(stdinEvents, {
                write(chunk: string, settled?: (error?: Error) => void) {
                    try {
                        if (usesRequestWriteError
                            && chunk.startsWith(HYPER_V_WINDOWS_SESSION_REQUEST_PREFIX)) {
                            settled?.(new Error("simulated request write failure"));
                            return true;
                        }
                        if (usesCloseWriteTimer && chunk.startsWith(elevationClosePrefix)) {
                            closeObserved = true;
                            closeWriteSettled = settled ?? null;
                            return true;
                        }
                        acceptInput(chunk);
                        settled?.();
                        return true;
                    } catch (error) {
                        simulationError = error;
                        settled?.(error instanceof Error ? error : new Error("simulation failed"));
                        return false;
                    }
                },
                end() {
                    stdinEndCalls += 1;
                    stdinEndedAfterCloseWrite = true;
                    stdinEvents.emit("finish");
                    const deferred = completeAfterStdinEnd;
                    completeAfterStdinEnd = null;
                    if (deferred) queueMicrotask(deferred);
                    if (usesCloseWriteTimer) {
                        const delayedSettlement = closeWriteSettled;
                        closeWriteSettled = null;
                        if (order === "close-write-timeout-delayed-success") delayedSettlement?.();
                        if (order === "close-write-timeout-delayed-error") {
                            delayedSettlement?.(new Error("simulated delayed close-write failure"));
                        }
                        queueMicrotask(() => {
                            stdout.emit("end");
                            events.emit("exit", 1, null);
                            events.emit("close", 1, null);
                        });
                    }
                    if (order === "ack-stdin-error" && stdinEndCalls === 1) {
                        stdinEvents.emit("error", new Error("simulated stdin close failure"));
                    }
                    return stdin;
                },
            });
            const child = Object.assign(events, { stdin, stdout, stderr, kill });
            childProcessMocks.spawn.mockReset();
            childProcessMocks.spawn.mockReturnValueOnce(child);

            const resultPromise = withElevatedHyperVNetworkExecutor({
                executable,
                deadlineUnixMilliseconds: Date.now() + 30_000,
            }, (executor) => executor.execute(getVmRequest(), executorContext()));
            const expectsFailure = order === "invalid-ack"
                || order === "duplicate-ack"
                || order === "exit-before-duplicate-ack"
                || order === "exit-before-truncated-duplicate-ack"
                || order === "truncated-invalid-ack"
                || order === "truncated-short-prefix"
                || order === "exit-before-ack-with-extra-line"
                || order === "premature-ack"
                || order === "abrupt-stdin-error-truncated-eof"
                || order === "graceful-force-timeout"
                || usesLateForceOrdering
                || usesPreForceEvidence
                || order === "elevated-child-failure-followed-by-control"
                || usesRequestWriteError
                || usesWrapperOutputDrain
                || order === "close-write-timeout"
                || order === "close-write-timeout-delayed-success"
                || order === "close-write-timeout-delayed-error"
                || order === "ack-close-without-exit"
                || order === "ack-exit-close-without-stdout-end"
                || order === "ack-stdin-error";
            const expectedTerminationStage = order === "invalid-ack"
                || order === "duplicate-ack"
                || order === "exit-before-duplicate-ack"
                || order === "exit-before-truncated-duplicate-ack"
                || order === "truncated-invalid-ack"
                || order === "truncated-short-prefix"
                || order === "exit-before-ack-with-extra-line"
                || order === "premature-ack"
                ? "relay-terminal-ack-invalid"
                : order === "elevated-child-failure-followed-by-control"
                    ? "elevated-child"
                : order === "ack-close-without-exit"
                    ? "relay-process-exit-timeout"
                    : order === "ack-exit-close-without-stdout-end"
                        ? "relay-output-drain-timeout"
                        : usesWrapperOutputDrain
                            ? "relay-output-drain-timeout"
                        : order === "graceful-force-timeout"
                            ? "relay-terminal-ack-missing"
                            : usesLateForceOrdering
                                ? "elevated-child"
                                : order === "exit-stdin-error-late-child-failure"
                                    ? "elevated-child"
                                    : order === "exit-and-stdout-before-force-no-close"
                                        ? "relay-terminal-ack-missing"
                    : "relay-input-write";
            const settledResult = expectsFailure
                ? resultPromise.then(() => null, (error: unknown) => error)
                : resultPromise;
            let result: unknown;
            try {
                if (usesRequestWriteError) {
                    let settledEarly = false;
                    void resultPromise.then(
                        () => { settledEarly = true; },
                        () => { settledEarly = true; },
                    );
                    await vi.advanceTimersByTimeAsync(0);
                    expect(settledEarly).toBe(false);
                }
                if (usesWrapperOutputDrain) await vi.advanceTimersByTimeAsync(15_001);
                else if (usesForceTimer) await vi.advanceTimersByTimeAsync(10_001);
                else if (usesCloseWriteTimer) await vi.advanceTimersByTimeAsync(1_001);
                if (usesLateForceOrdering) {
                    if (order === "force-before-exit-late-child-failure") {
                        events.emit("exit", 1, null);
                    }
                    stdout.emit(
                        "data",
                        "CCC_HYPER_V_ELEVATED_NETWORK_FAILURE:"
                        + "hyper-v-network-elevation-termination-unconfirmed\n",
                    );
                    stdout.emit("end");
                    events.emit("close", 1, null);
                }
                result = await settledResult;
            } finally {
                if (usesFakeTimers) vi.useRealTimers();
            }

            expect(childProcessMocks.spawn).toHaveBeenCalledTimes(1);
            expect(childProcessMocks.spawn.mock.results[0]?.value).toBe(child);
            expect(simulationError).toBeNull();
            expect(launchObserved).toBe(true);
            expect(closeObserved).toBe(
                order !== "premature-ack"
                    && !usesAbruptForceTimer
                    && !usesInvalidProgress
                    && !usesAbsorbingFailure
                    && !usesRequestWriteError,
            );
            expect(stdinEndedAfterCloseWrite).toBe(true);
            expect(stdinEndCalls).toBe(1);
            if (forceKillsRelay) expect(kill).toHaveBeenCalledTimes(1);
            else expect(kill).not.toHaveBeenCalled();
            if (usesInvalidProgress || order === "protocol-failure-followed-by-control") {
                expect(result).toMatchObject({
                    status: null,
                    stdout: "",
                    error: "hyper-v-network-elevation-protocol-invalid",
                });
            } else if (expectsFailure) {
                expect(result).toMatchObject({
                    code: "hyper-v-network-elevation-termination-unconfirmed",
                    terminationStage: expectedTerminationStage,
                });
                if (order === "abrupt-stdin-error-truncated-eof") {
                    expect(result).toMatchObject({
                        terminationDiagnostic: {
                            relay: {
                                shutdownMode: "abrupt",
                                progressStage: "relay-ready",
                                closeWriteStatus: "not-started",
                                forceExpired: true,
                            },
                            execution: {
                                lastOperation: "Get-VM",
                                lastSessionError: null,
                            },
                        },
                    });
                }
                if (usesPreForceEvidence) {
                    expect(result).toMatchObject({
                        terminationDiagnostic: {
                            relay: {
                                shutdownMode: order === "exit-stdin-error-late-child-failure"
                                    ? "abrupt"
                                    : "graceful",
                                processExited: true,
                                stdoutDrained: true,
                                forceExpired: true,
                            },
                        },
                    });
                }
                if (order === "elevated-child-failure-followed-by-control") {
                    expect(result).toMatchObject({
                        terminationDiagnostic: {
                            relay: { progressStage: "relay-ready" },
                        },
                    });
                }
                if (usesWrapperOutputDrain) {
                    expect(result).toMatchObject({
                        terminationDiagnostic: {
                            relay: {
                                shutdownMode: "graceful",
                                processExited: true,
                                stdoutDrained: false,
                                forceExpired: true,
                            },
                        },
                    });
                }
                if (order === "close-write-timeout"
                    || order === "close-write-timeout-delayed-success"
                    || order === "close-write-timeout-delayed-error") {
                    expect(result).toMatchObject({
                        terminationDiagnostic: {
                            relay: {
                                shutdownMode: "abrupt",
                                closeWriteStatus: "timed-out",
                            },
                        },
                    });
                }
                if (order === "graceful-force-timeout") {
                    expect(result).toMatchObject({
                        terminationDiagnostic: {
                            relay: {
                                shutdownMode: "abrupt",
                                closeWriteStatus: "succeeded",
                                forceExpired: true,
                            },
                        },
                    });
                }
                if (usesLateForceOrdering) {
                    expect(result).toMatchObject({
                        terminationDiagnostic: {
                                relay: {
                                    shutdownMode: "abrupt",
                                stdoutDrained: true,
                                forceExpired: true,
                            },
                        },
                    });
                }
                if (order === "ack-close-without-exit"
                    || order === "ack-exit-close-without-stdout-end") {
                    expect(result).toMatchObject({
                        terminationDiagnostic: {
                            relay: {
                                shutdownMode: "graceful",
                                progressStage: "terminal-write-entered",
                            },
                        },
                    });
                }
            } else {
                expect(result).toEqual({ status: 0, stdout: successEnvelope("Get-VM") });
            }
        },
    );

    it("still fails closed when the outer relay never confirms termination", async () => {
        vi.useFakeTimers();
        try {
            const relay = fakeRelay();
            const process: HyperVElevatedNetworkRelayProcess = {
                ...relay.process,
                completion: new Promise(() => undefined),
                diagnostic() {
                    throw new Error("native secret");
                },
                close() {},
                kill() {},
            };

            const result = withElevatedHyperVNetworkExecutor({
                executable,
                deadlineUnixMilliseconds: Date.now() + 30_000,
                spawnRelay: async (request) => {
                    request.onBeforeElevation();
                    return process;
                },
            }, (executor) => executor.execute(getVmRequest(), executorContext()));

            const rejection = expect(result).rejects.toMatchObject({
                code: "hyper-v-network-elevation-termination-unconfirmed",
                message: "hyper-v-network-elevation-termination-unconfirmed",
                terminationStage: "relay-completion-timeout",
                terminationDiagnostic: {
                    relay: null,
                },
            });
            await vi.advanceTimersByTimeAsync(14_999);
            expect(vi.getTimerCount()).toBeGreaterThan(0);
            await vi.advanceTimersByTimeAsync(1);
            await rejection;
        } finally {
            vi.useRealTimers();
        }
    });

    it("adopts the relay even when its optional diagnostic accessor throws", async () => {
        const relay = fakeRelay();
        Object.defineProperty(relay.process, "diagnostic", {
            configurable: true,
            get() {
                throw new Error("native secret");
            },
        });

        const result = await withElevatedHyperVNetworkExecutor({
            executable,
            deadlineUnixMilliseconds: Date.now() + 30_000,
            spawnRelay: async (request) => {
                request.onBeforeElevation();
                return relay.process;
            },
        }, (executor) => executor.execute(getVmRequest(), executorContext()));

        expect(result).toEqual({ status: 0, stdout: successEnvelope("Get-VM") });
        expect(relay.gracefullyClosed()).toBe(true);
        expect(relay.forceKilled()).toBe(false);
    });

    it.each(["rejected", "unknown-code", "throwing-getter"] as const)(
        "fails closed for a %s injected relay completion",
        async (completionKind) => {
            const relay = fakeRelay();
            const secret = "native completion secret";
            const result = withElevatedHyperVNetworkExecutor({
                executable,
                deadlineUnixMilliseconds: Date.now() + 30_000,
                spawnRelay: async (request) => {
                    request.onBeforeElevation();
                    const process = { ...relay.process };
                    let completion: unknown;
                    if (completionKind === "rejected") {
                        completion = Promise.reject(new Error(secret));
                    } else if (completionKind === "unknown-code") {
                        completion = Promise.resolve({ errorCode: secret, terminationStage: null });
                    } else {
                        const value = { terminationStage: null };
                        Object.defineProperty(value, "errorCode", {
                            get() {
                                throw new Error(secret);
                            },
                        });
                        completion = Promise.resolve(value);
                    }
                    Object.defineProperty(process, "completion", { value: completion });
                    return process;
                },
            }, (executor) => executor.execute(getVmRequest(), executorContext()));

            const observed = await result.then(() => null, (error: unknown) => error);
            expect(observed).toMatchObject({
                code: "hyper-v-network-elevation-termination-unconfirmed",
                terminationStage: "relay-completion-timeout",
            });
            expect(JSON.stringify(observed)).not.toContain(secret);
        },
    );

    it("bounds a throwing injected relay failure provider", async () => {
        const relay = fakeRelay();
        const secret = "native failure provider secret";
        const process: HyperVElevatedNetworkRelayProcess = {
            ...relay.process,
            failureCode() {
                throw new Error(secret);
            },
        };

        const observed = await withElevatedHyperVNetworkExecutor({
            executable,
            deadlineUnixMilliseconds: Date.now() + 30_000,
            spawnRelay: async (request) => {
                request.onBeforeElevation();
                return process;
            },
        }, (executor) => executor.execute(getVmRequest(), executorContext()))
            .then(() => null, (error: unknown) => error);

        expect(observed).toMatchObject({ code: "hyper-v-network-elevation-protocol-invalid" });
        expect(JSON.stringify(observed)).not.toContain(secret);
    });

    it.each(["throwing-getter", "throwing-proxy"] as const)(
        "keeps a bounded relay failure authoritative over a %s callback result",
        async (resultKind) => {
            const relay = fakeRelay();
            const process: HyperVElevatedNetworkRelayProcess = {
                ...relay.process,
                completion: Promise.resolve({
                    errorCode: "hyper-v-network-elevation-relay-failed",
                    terminationStage: null,
                }),
            };
            const secret = "native callback getter secret";

            const observed = await withElevatedHyperVNetworkExecutor({
                executable,
                deadlineUnixMilliseconds: Date.now() + 30_000,
                spawnRelay: async (request) => {
                    request.onBeforeElevation();
                    return process;
                },
            }, async (executor) => {
                await executor.execute(getVmRequest(), executorContext());
                if (resultKind === "throwing-proxy") {
                    return new Proxy({}, {
                        get(_target, property) {
                            if (property === "then") return undefined;
                            throw new Error(secret);
                        },
                    });
                }
                return Object.defineProperty({}, "status", {
                    get() {
                        throw new Error(secret);
                    },
                });
            }).then(() => null, (error: unknown) => error);

            expect(observed).toMatchObject({ code: "hyper-v-network-elevation-relay-failed" });
            expect(JSON.stringify(observed)).not.toContain(secret);
        },
    );

    it("extracts diagnostics only from a correlated termination error", () => {
        const termination = new HyperVElevatedNetworkSessionError(
            "hyper-v-network-elevation-termination-unconfirmed",
            "relay-process-exit-timeout",
        );
        expect(getHyperVElevatedNetworkTerminationStage(termination)).toBe("relay-process-exit-timeout");
        expect(getHyperVElevatedNetworkTerminationDiagnostic(termination)).toBeNull();

        const diagnostic = new HyperVElevatedNetworkSessionError(
            "hyper-v-network-elevation-termination-unconfirmed",
            "relay-terminal-ack-missing",
            {
                relay: {
                    shutdownMode: "abrupt",
                    progressStage: "request-forwarded",
                    closeWriteStatus: "not-started",
                    processExited: false,
                    stdoutDrained: false,
                    stderrObserved: false,
                    forceExpired: true,
                },
                execution: {
                    lastOperation: "Get-VM",
                    lastSessionError: "hyper-v-windows-session-queue-timeout",
                    activeExecutions: 1,
                    pendingExecutions: 1,
                },
            },
        );
        expect(getHyperVElevatedNetworkTerminationDiagnostic(diagnostic)).toMatchObject({
            relay: { shutdownMode: "abrupt", progressStage: "request-forwarded" },
            execution: { lastSessionError: "hyper-v-windows-session-queue-timeout" },
        });

        const highCount = new HyperVElevatedNetworkSessionError(
            "hyper-v-network-elevation-termination-unconfirmed",
            "relay-terminal-ack-missing",
            {
                relay: null,
                execution: {
                    lastOperation: "Get-VM",
                    lastSessionError: null,
                    activeExecutions: 1_000,
                    pendingExecutions: 1_000,
                },
            },
        );
        expect(getHyperVElevatedNetworkTerminationDiagnostic(highCount)).toMatchObject({
            execution: { activeExecutions: 1_000, pendingExecutions: 1_000 },
        });

        const invalidStage = new HyperVElevatedNetworkSessionError(
            "hyper-v-network-elevation-termination-unconfirmed",
            "relay-terminal-ack-missing",
            {
                relay: null,
                execution: {
                    lastOperation: "Get-VM",
                    lastSessionError: null,
                    activeExecutions: 0,
                    pendingExecutions: 0,
                },
            },
        );
        Reflect.set(invalidStage, "terminationStage", "native-secret");
        expect(getHyperVElevatedNetworkTerminationStage(invalidStage)).toBeNull();
        expect(getHyperVElevatedNetworkTerminationDiagnostic(invalidStage)).toBeNull();

        const invalidDiagnostic = new HyperVElevatedNetworkSessionError(
            "hyper-v-network-elevation-termination-unconfirmed",
            "relay-terminal-ack-missing",
            {
                relay: {
                    shutdownMode: "C:\\secret\nINJECT",
                    progressStage: "token=abc",
                    closeWriteStatus: "not-started",
                    processExited: false,
                    stdoutDrained: false,
                    stderrObserved: false,
                    forceExpired: true,
                },
                execution: {
                    lastOperation: "Get-VM",
                    lastSessionError: "native text",
                    activeExecutions: 1,
                    pendingExecutions: 0,
                },
            } as never,
        );
        expect(getHyperVElevatedNetworkTerminationDiagnostic(invalidDiagnostic)).toBeNull();
        Reflect.set(diagnostic, "terminationDiagnostic", {
            relay: { shutdownMode: "native secret" },
            execution: {},
        });
        expect(getHyperVElevatedNetworkTerminationDiagnostic(diagnostic)).toBeNull();

        const throwing = new HyperVElevatedNetworkSessionError(
            "hyper-v-network-elevation-termination-unconfirmed",
            "relay-terminal-ack-missing",
        );
        const throwingSnapshot = {};
        Object.defineProperty(throwingSnapshot, "relay", {
            get() {
                throw new Error("native secret");
            },
        });
        Reflect.set(throwing, "terminationDiagnostic", throwingSnapshot);
        expect(() => getHyperVElevatedNetworkTerminationDiagnostic(throwing)).not.toThrow();
        expect(getHyperVElevatedNetworkTerminationDiagnostic(throwing)).toBeNull();

        let processExitedReads = 0;
        const changing = new HyperVElevatedNetworkSessionError(
            "hyper-v-network-elevation-termination-unconfirmed",
            "relay-terminal-ack-missing",
        );
        const changingRelay = {
            shutdownMode: "abrupt",
            progressStage: "request-forwarded",
            closeWriteStatus: "not-started",
            stdoutDrained: false,
            stderrObserved: false,
            forceExpired: true,
        };
        Object.defineProperty(changingRelay, "processExited", {
            get() {
                processExitedReads += 1;
                return processExitedReads === 1 ? true : "native secret";
            },
        });
        Reflect.set(changing, "terminationDiagnostic", {
            relay: changingRelay,
            execution: {
                lastOperation: "Get-VM",
                lastSessionError: null,
                activeExecutions: 0,
                pendingExecutions: 0,
            },
        });
        expect(getHyperVElevatedNetworkTerminationDiagnostic(changing)).toMatchObject({
            relay: { processExited: true },
        });
        expect(processExitedReads).toBe(1);

        const revoked = new HyperVElevatedNetworkSessionError(
            "hyper-v-network-elevation-termination-unconfirmed",
            "relay-terminal-ack-missing",
        );
        const revocable = Proxy.revocable({}, {});
        revocable.revoke();
        Reflect.set(revoked, "terminationDiagnostic", revocable.proxy);
        expect(getHyperVElevatedNetworkTerminationDiagnostic(revoked)).toBeNull();

        expect(Object.isFrozen(HYPER_V_ELEVATED_NETWORK_RELAY_PROGRESS_STAGES)).toBe(true);
        expect(Object.isFrozen(HYPER_V_ELEVATED_NETWORK_ERROR_CODES)).toBe(true);
        expect(Object.isFrozen(HYPER_V_ELEVATED_NETWORK_TERMINATION_STAGES)).toBe(true);
        expect(Object.isFrozen(HYPER_V_WINDOWS_OPERATIONS)).toBe(true);
        expect(Object.isFrozen(HYPER_V_WINDOWS_SESSION_ERROR_CODES)).toBe(true);
        expect(Reflect.set(
            HYPER_V_ELEVATED_NETWORK_RELAY_PROGRESS_STAGES,
            HYPER_V_ELEVATED_NETWORK_RELAY_PROGRESS_STAGES.length,
            "native-secret",
        )).toBe(false);

        const unrelated = new HyperVElevatedNetworkSessionError("hyper-v-network-elevation-cancelled");
        Reflect.set(unrelated, "terminationStage", "relay-input-write");
        expect(getHyperVElevatedNetworkTerminationStage(unrelated)).toBeNull();
        expect(getHyperVElevatedNetworkTerminationDiagnostic(unrelated)).toBeNull();
        expect(getHyperVElevatedNetworkTerminationStage(new Error("native secret"))).toBeNull();
    });

    it("pins the line-framed relay and its authentication controls", () => {
        const requestIndex = HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP.indexOf(
            "CCC_HYPER_V_ELEVATED_NETWORK_REQUEST",
        );
        const approvalIndex = HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP.indexOf(
            "CCC_HYPER_V_ELEVATED_NETWORK_APPROVE",
        );
        const runAsIndex = HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP.indexOf("-Verb RunAs");

        expect(HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP).toContain("-Verb RunAs");
        expect(HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP).toContain("S-1-5-32-544");
        expect(HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP).toContain("GetNamedPipeClientProcessId");
        expect(HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP).toContain("startTicks");
        expect(HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP).toContain("administrator");
        expect(HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP).not.toContain("CopyToAsync");
        expect(HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP).not.toContain("OpenStandardInput");
        expect(HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP).toContain("[void]$Y.WaitForExit($M)");
        expect(HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP).toContain("terminalToken");
        expect(HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP).toContain(
            "CCC_HYPER_V_ELEVATED_NETWORK_PROGRESS:",
        );
        expect(HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP).toContain("Send-Progress 'close-received'");
        expect(HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP).toContain("Send-Progress 'finalizer-entered'");
        expect(HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP).toContain("Send-Progress 'terminal-write-entered'");
        expect(HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP).toContain(
            "CCC_HYPER_V_ELEVATED_NETWORK_TERMINAL:",
        );
        expect(HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP).not.toContain("\0");
        expect(HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP.length).toBeLessThan(8_000);
        expect(HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP.match(/-Verb RunAs/g)).toHaveLength(1);
        expect(requestIndex).toBeGreaterThanOrEqual(0);
        expect(approvalIndex).toBeGreaterThan(requestIndex);
        expect(runAsIndex).toBeGreaterThan(approvalIndex);
        const assetForward = HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP.indexOf(
            "$W.WriteLine($L);$W.Flush();Send-Progress 'operation-asset-forwarded';$V=$R.ReadLine()",
        );
        const requestValidation = HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP.indexOf(
            `if(-not $L.StartsWith('${HYPER_V_WINDOWS_SESSION_REQUEST_PREFIX}'))`,
        );
        const responseForward = HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP.indexOf(
            `-not $V.StartsWith('${HYPER_V_WINDOWS_SESSION_RESPONSE_PREFIX}'))`,
        );
        const closeForward = HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP.indexOf(
            `$K='${elevationClosePrefix}'+$Z+':'`,
        );
        const childCloseForward = HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP.indexOf(
            `$W.WriteLine('${HYPER_V_WINDOWS_SESSION_CLOSE_MARKER}');$W.Flush();`
            + "Send-Progress 'child-close-forwarded';$CL=$true;break",
        );
        const childExitWait = HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP.indexOf("$C.WaitForExit($M)");
        const pipeDisposal = HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP.indexOf("$Q.Dispose()");
        const terminalOutput = HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP.indexOf("if($CL-and $Z-match");
        expect(assetForward).toBeGreaterThanOrEqual(0);
        expect(assetForward).toBeLessThan(requestValidation);
        expect(requestValidation).toBeLessThan(responseForward);
        expect(closeForward).toBeGreaterThanOrEqual(0);
        expect(closeForward).toBeLessThan(childCloseForward);
        expect(childCloseForward).toBeLessThan(childExitWait);
        expect(childExitWait).toBeLessThan(pipeDisposal);
        expect(pipeDisposal).toBeLessThan(terminalOutput);
        expect(HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP).toContain("$null-eq $L){throw 'input'}");
        expect(HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP).toContain("$null-eq $V-or $V.Length-gt");
        expect(HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP).toContain("[long]::TryParse($V,[ref]$G)");
        expect(HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP).toContain(
            "$G-[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()-500",
        );
        expect(HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP).not.toContain(
            "$G=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()+5000",
        );
        expect(HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP).not.toMatch(/(?:Get|New|Set|Remove)-(?:VM|Net)/);
    });

    it("routes the exact generated relay through the Windows parser gate before UAC", () => {
        const validator = readFileSync(join(process.cwd(), "scripts", "validate-hyper-v-powershell.mjs"), "utf8");
        const command = readFileSync(join(
            process.cwd(),
            "scripts",
            "real-tests",
            "hyper-v-windows-network-command.mjs",
        ), "utf8");

        expect(validator).toContain("HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP");
        expect(validator).toContain('"--import", "tsx"');
        expect(validator).toContain("if (requireParser && useFullAssetSet && !elevatedRelayBootstrap)");
        expect(command.indexOf("const parsed = runNodeTool(")).toBeLessThan(
            command.indexOf("return runNodeTool(esbuildPath"),
        );
        expect(command).toContain('process.platform === "win32" ? ["--require-parser"] : []');
    });

    it("materializes the generated relay without native TypeScript stripping", async () => {
        const { spawnSync } = await vi.importActual<typeof import("child_process")>("child_process");
        const module = pathToFileURL(join(
            process.cwd(),
            "src",
            "device-lab",
            "broker",
            "hyper-v",
            "elevated-network-session.ts",
        )).href;
        const supportsStripTypesFlag = process.allowedNodeEnvironmentFlags.has("--no-experimental-strip-types");
        const result = spawnSync(process.execPath, [
            ...(supportsStripTypesFlag ? ["--no-experimental-strip-types"] : []),
            "--import",
            "tsx",
            "-e",
            `import(${JSON.stringify(module)}).then((m) => process.stdout.write(typeof m.HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP))`,
        ], {
            cwd: process.cwd(),
            encoding: "utf8",
            windowsHide: true,
        });

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe("string");
    });

    it("keeps the terminal token out of the elevated child and accepts it only during close", () => {
        const source = readFileSync(join(
            process.cwd(),
            "src",
            "device-lab",
            "broker",
            "hyper-v",
            "elevated-network-session.ts",
        ), "utf8");
        const elevatedSourceStart = source.indexOf("function elevatedChildSource(");
        const elevatedSourceEnd = source.indexOf("// This process remains medium-integrity", elevatedSourceStart);
        const elevatedSource = source.slice(elevatedSourceStart, elevatedSourceEnd);
        const terminalHandlerStart = source.indexOf("if (line.startsWith(ELEVATION_TERMINAL_PREFIX))");
        const terminalHandlerEnd = source.indexOf("\n        return false;", terminalHandlerStart);
        const terminalHandler = source.slice(terminalHandlerStart, terminalHandlerEnd);

        expect(elevatedSourceStart).toBeGreaterThanOrEqual(0);
        expect(elevatedSourceEnd).toBeGreaterThan(elevatedSourceStart);
        expect(elevatedSource).not.toContain("terminalToken");
        expect(terminalHandlerStart).toBeGreaterThanOrEqual(0);
        expect(terminalHandlerEnd).toBeGreaterThan(terminalHandlerStart);
        expect(terminalHandler).toContain("!closing");
        expect(terminalHandler).toContain("line !== `${ELEVATION_TERMINAL_PREFIX}${terminalToken}`");
        expect(terminalHandler).not.toContain("endRelayInput()");
    });

    it("ends relay stdin only after the graceful close frame write completes", () => {
        const source = readFileSync(join(
            process.cwd(),
            "src",
            "device-lab",
            "broker",
            "hyper-v",
            "elevated-network-session.ts",
        ), "utf8");
        const closeStart = source.indexOf("const close = () => {");
        const closeEnd = source.indexOf("\n    };\n    const flushQueued", closeStart);
        const closeSource = source.slice(closeStart, closeEnd);

        expect(source).toContain("const RELAY_CLOSE_WRITE_GRACE_MILLISECONDS = 1_000");
        expect(source).toContain("const ELEVATED_CHILD_TERMINATION_CONFIRMATION_MILLISECONDS = 5_000");
        expect(source).toContain("const RELAY_FORCE_GRACE_MILLISECONDS = 10_000");
        expect(source).toContain("const RELAY_COMPLETION_GRACE_MILLISECONDS = 15_000");
        expect(closeStart).toBeGreaterThanOrEqual(0);
        expect(closeEnd).toBeGreaterThan(closeStart);
        expect(closeSource).toContain("const finalizationDeadline = Date.now()");
        expect(closeSource).toContain("child.stdin?.write(`${ELEVATION_CLOSE_PREFIX}${terminalToken}:${finalizationDeadline}\\n`");
        expect(closeSource).toContain("endRelayInput()");
        const clearDeadline = closeSource.indexOf("clearTimeout(deadlineTimer)");
        const writeClose = closeSource.indexOf("child.stdin?.write");
        const endStdin = closeSource.indexOf("endRelayInput()");
        expect(clearDeadline).toBeGreaterThanOrEqual(0);
        expect(clearDeadline).toBeLessThan(writeClose);
        expect(writeClose).toBeLessThan(endStdin);
    });

    it("preserves relay failure precedence in both event orderings", () => {
        const empty: HyperVElevatedNetworkRelayCompletion = {
            errorCode: null,
            terminationStage: null,
        };
        const primary = transitionHyperVElevatedNetworkRelayFailure(empty, {
            kind: "replace-primary",
            code: "hyper-v-network-elevation-deadline-exceeded",
        });
        expect(transitionHyperVElevatedNetworkRelayFailure(primary, {
            kind: "termination",
            stage: "relay-terminal-ack-missing",
            replaceFailure: false,
        })).toEqual(primary);

        const fallback = transitionHyperVElevatedNetworkRelayFailure(empty, {
            kind: "termination",
            stage: "relay-terminal-ack-missing",
            replaceFailure: false,
        });
        expect(transitionHyperVElevatedNetworkRelayFailure(fallback, {
            kind: "replace-primary",
            code: "hyper-v-network-elevation-protocol-invalid",
        })).toEqual({
            errorCode: "hyper-v-network-elevation-protocol-invalid",
            terminationStage: null,
        });

        const authoritativeChild = transitionHyperVElevatedNetworkRelayFailure(primary, {
            kind: "termination",
            stage: "elevated-child",
            replaceFailure: true,
        });
        expect(authoritativeChild).toEqual({
            errorCode: "hyper-v-network-elevation-termination-unconfirmed",
            terminationStage: "elevated-child",
        });
        expect(transitionHyperVElevatedNetworkRelayFailure(authoritativeChild, {
            kind: "replace-primary",
            code: "hyper-v-network-elevation-protocol-invalid",
        })).toEqual(authoritativeChild);
    });

    it("does not widen the executor result when a callback throws", async () => {
        const expected = new Error("callback-failed");
        const spawnRelay = vi.fn<HyperVElevatedNetworkRelaySpawn>();

        await expect(withElevatedHyperVNetworkExecutor({
            executable,
            deadlineUnixMilliseconds: Date.now() + 30_000,
            spawnRelay,
        }, async (_executor: HyperVWindowsExecutor): Promise<HyperVWindowsExecutionResult> => {
            throw expected;
        })).rejects.toBe(expected);
        expect(spawnRelay).not.toHaveBeenCalled();
    });
});
