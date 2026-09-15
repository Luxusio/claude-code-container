import { readFileSync } from "fs";
import { EventEmitter } from "events";
import { join } from "path";
import { describe, expect, it, vi } from "vitest";

const childProcessMocks = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock("child_process", () => ({ spawn: childProcessMocks.spawn }));
vi.mock("../windows-system-powershell.js", async (importOriginal) => ({
    ...await importOriginal<typeof import("../windows-system-powershell.js")>(),
    canonicalWindowsPowerShellPath: () => "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
}));

import {
    HYPER_V_WINDOWS_SESSION_CLOSE_MARKER,
    HYPER_V_WINDOWS_SESSION_REQUEST_PREFIX,
    HYPER_V_WINDOWS_SESSION_RESPONSE_PREFIX,
    type HyperVWindowsExecutionRequest,
    type HyperVWindowsExecutionResult,
    type HyperVWindowsExecutor,
    type HyperVWindowsSessionErrorCode,
} from "../hyper-v-windows/index.js";
import {
    HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP,
    HyperVElevatedNetworkSessionError,
    getHyperVElevatedNetworkTerminationStage,
    transitionHyperVElevatedNetworkRelayFailure,
    withElevatedHyperVNetworkExecutor,
    type HyperVElevatedNetworkErrorCode,
    type HyperVElevatedNetworkRelayCompletion,
    type HyperVElevatedNetworkRelayFailureEvent,
    type HyperVElevatedNetworkRelayProcess,
    type HyperVElevatedNetworkRelaySpawn,
    type HyperVElevatedNetworkTerminationStage,
} from "../device-lab/broker/hyper-v/elevated-network-session.js";

const executable = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const vmId = "11111111-2222-3333-4444-555555555555";

function getVmRequest(): HyperVWindowsExecutionRequest {
    return {
        schemaVersion: 1,
        operation: "Get-VM",
        selector: { kind: "id", id: vmId },
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
        "abrupt-stdin-error-truncated-eof",
        "close-write-timeout",
        "ack-close-without-exit",
        "ack-exit-close-without-stdout-end",
        "ack-stdin-error",
    ] as const)(
        "handles correlated relay terminal protocol (%s) without depending on close for success",
        async (order) => {
            const usesForceTimer = order === "abrupt-stdin-error-truncated-eof";
            const usesCloseWriteTimer = order === "close-write-timeout";
            const usesFakeTimers = usesForceTimer || usesCloseWriteTimer;
            if (usesFakeTimers) vi.useFakeTimers();
            const events = new EventEmitter();
            const stdoutEvents = new EventEmitter();
            const stderr = new EventEmitter();
            const stdout = Object.assign(stdoutEvents, { setEncoding: () => stdout });
            const kill = vi.fn(() => {
                if (usesForceTimer) {
                    stdout.emit("data", "CCC_HYPER_V_ELEVATED_");
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
                            stdout.emit("data", "CCC_HYPER_V_ELEVATED_NETWORK_RELAY_READY\n");
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
                        queueMicrotask(() => {
                            stdout.emit(
                                "data",
                                `${HYPER_V_WINDOWS_SESSION_RESPONSE_PREFIX}${reply}\n`,
                            );
                            if (usesForceTimer) {
                                stdinEvents.emit("error", new Error("simulated abrupt stdin failure"));
                            }
                        });
                    } else if (line === HYPER_V_WINDOWS_SESSION_CLOSE_MARKER) {
                        closeObserved = true;
                        expect(stdinEndedAfterCloseWrite).toBe(false);
                        const completeRelay = () => {
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
                            const acknowledge = () => {
                                expect(stdinEndedAfterCloseWrite).toBe(true);
                                stdout.emit(
                                    "data",
                                    `CCC_HYPER_V_ELEVATED_NETWORK_TERMINAL:${terminalToken}\n`,
                                );
                            };
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
                        else queueMicrotask(completeRelay);
                    }
                    index = input.indexOf("\n");
                }
            };
            const stdinEvents = new EventEmitter();
            const stdin = Object.assign(stdinEvents, {
                write(chunk: string, settled?: (error?: Error) => void) {
                    try {
                        if (usesCloseWriteTimer && chunk === `${HYPER_V_WINDOWS_SESSION_CLOSE_MARKER}\n`) {
                            closeObserved = true;
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
                || order === "close-write-timeout"
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
                : order === "ack-close-without-exit"
                    ? "relay-process-exit-timeout"
                    : order === "ack-exit-close-without-stdout-end"
                        ? "relay-output-drain-timeout"
                    : "relay-input-write";
            const settledResult = expectsFailure
                ? resultPromise.then(() => null, (error: unknown) => error)
                : resultPromise;
            let result: unknown;
            try {
                if (usesForceTimer) await vi.advanceTimersByTimeAsync(10_001);
                else if (usesCloseWriteTimer) await vi.advanceTimersByTimeAsync(1_001);
                result = await settledResult;
            } finally {
                if (usesFakeTimers) vi.useRealTimers();
            }

            expect(childProcessMocks.spawn).toHaveBeenCalledTimes(1);
            expect(childProcessMocks.spawn.mock.results[0]?.value).toBe(child);
            expect(simulationError).toBeNull();
            expect(launchObserved).toBe(true);
            expect(closeObserved).toBe(order !== "premature-ack" && !usesForceTimer);
            expect(stdinEndedAfterCloseWrite).toBe(true);
            expect(stdinEndCalls).toBe(1);
            if (usesForceTimer) expect(kill).toHaveBeenCalledTimes(1);
            else expect(kill).not.toHaveBeenCalled();
            if (expectsFailure) {
                expect(result).toMatchObject({
                    code: "hyper-v-network-elevation-termination-unconfirmed",
                    terminationStage: expectedTerminationStage,
                });
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
            });
            await vi.advanceTimersByTimeAsync(14_999);
            expect(vi.getTimerCount()).toBeGreaterThan(0);
            await vi.advanceTimersByTimeAsync(1);
            await rejection;
        } finally {
            vi.useRealTimers();
        }
    });

    it("makes relay termination code and stage impossible to separate", () => {
        const valid: HyperVElevatedNetworkRelayCompletion = {
            errorCode: "hyper-v-network-elevation-termination-unconfirmed",
            terminationStage: "elevated-child",
        };
        expect(valid.terminationStage).toBe("elevated-child");

        // @ts-expect-error Termination uncertainty requires its correlated bounded stage.
        const missingStage: HyperVElevatedNetworkRelayCompletion = {
            errorCode: "hyper-v-network-elevation-termination-unconfirmed",
            terminationStage: null,
        };
        // @ts-expect-error Non-termination failures cannot carry a termination stage.
        const unrelatedStage: HyperVElevatedNetworkRelayCompletion = {
            errorCode: "hyper-v-network-elevation-cancelled",
            terminationStage: "relay-terminal-ack-missing",
        };
        expect([missingStage, unrelatedStage]).toHaveLength(2);

        // @ts-expect-error Relay fallbacks cannot replace an existing primary failure.
        const invalidFallbackOverride: HyperVElevatedNetworkRelayFailureEvent = {
            kind: "termination",
            stage: "relay-terminal-ack-missing",
            replaceFailure: true,
        };
        // @ts-expect-error The authenticated elevated-child result must replace earlier failures.
        const invalidChildPrecedence: HyperVElevatedNetworkRelayFailureEvent = {
            kind: "termination",
            stage: "elevated-child",
            replaceFailure: false,
        };
        expect([invalidFallbackOverride, invalidChildPrecedence]).toHaveLength(2);
    });

    it("extracts diagnostics only from a correlated termination error", () => {
        const termination = new HyperVElevatedNetworkSessionError(
            "hyper-v-network-elevation-termination-unconfirmed",
            "relay-process-exit-timeout",
        );
        expect(getHyperVElevatedNetworkTerminationStage(termination)).toBe("relay-process-exit-timeout");

        const unrelated = new HyperVElevatedNetworkSessionError("hyper-v-network-elevation-cancelled");
        Reflect.set(unrelated, "terminationStage", "relay-input-write");
        expect(getHyperVElevatedNetworkTerminationStage(unrelated)).toBeNull();
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
            "CCC_HYPER_V_ELEVATED_NETWORK_TERMINAL:",
        );
        expect(HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP).not.toContain("\0");
        expect(HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP.length).toBeLessThan(8_000);
        expect(HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP.match(/-Verb RunAs/g)).toHaveLength(1);
        expect(requestIndex).toBeGreaterThanOrEqual(0);
        expect(approvalIndex).toBeGreaterThan(requestIndex);
        expect(runAsIndex).toBeGreaterThan(approvalIndex);
        const assetForward = HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP.indexOf(
            "$W.WriteLine($L);$W.Flush();$V=$R.ReadLine()",
        );
        const requestValidation = HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP.indexOf(
            `if(-not $L.StartsWith('${HYPER_V_WINDOWS_SESSION_REQUEST_PREFIX}'))`,
        );
        const responseForward = HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP.indexOf(
            `-not $V.StartsWith('${HYPER_V_WINDOWS_SESSION_RESPONSE_PREFIX}'))`,
        );
        const closeForward = HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP.indexOf(
            `if($L-ceq '${HYPER_V_WINDOWS_SESSION_CLOSE_MARKER}'){$W.WriteLine($L);$W.Flush();$CL=$true;break}`,
        );
        const childExitWait = HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP.indexOf("$C.WaitForExit($M)");
        const pipeDisposal = HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP.indexOf("$Q.Dispose()");
        const terminalOutput = HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP.indexOf("if($CL-and $Z-match");
        expect(assetForward).toBeGreaterThanOrEqual(0);
        expect(assetForward).toBeLessThan(requestValidation);
        expect(requestValidation).toBeLessThan(responseForward);
        expect(closeForward).toBeGreaterThanOrEqual(0);
        expect(closeForward).toBeLessThan(childExitWait);
        expect(childExitWait).toBeLessThan(pipeDisposal);
        expect(pipeDisposal).toBeLessThan(terminalOutput);
        expect(HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP).toContain("$null-eq $L){throw 'input'}");
        expect(HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP).toContain("$null-eq $V-or $V.Length-gt");
        expect(HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP).not.toMatch(/(?:Get|New|Set|Remove)-(?:VM|Net)/);
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
        expect(closeSource).toContain("child.stdin?.write(`${HYPER_V_WINDOWS_SESSION_CLOSE_MARKER}\\n`");
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
