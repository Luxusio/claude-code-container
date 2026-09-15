import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it, vi } from "vitest";

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
    withElevatedHyperVNetworkExecutor,
    type HyperVElevatedNetworkErrorCode,
    type HyperVElevatedNetworkRelayProcess,
    type HyperVElevatedNetworkRelaySpawn,
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
    let errorCode: HyperVElevatedNetworkErrorCode | null = null;
    let closed = false;
    let graceful = false;
    let forced = false;
    let closeReason: HyperVWindowsSessionErrorCode = "hyper-v-windows-session-exited";
    let resolveCompletion = (_value: { readonly errorCode: HyperVElevatedNetworkErrorCode | null }) => undefined as void;
    const completion = new Promise<{ readonly errorCode: HyperVElevatedNetworkErrorCode | null }>((resolve) => {
        resolveCompletion = resolve;
    });
    const close = () => {
        if (closed) return;
        closed = true;
        resolveCompletion({ errorCode });
    };
    return {
        requests,
        gracefullyClosed: () => graceful,
        forceKilled: () => forced,
        process: {
            completion,
            failureCode: () => errorCode,
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
            errorCode = code;
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

    it("fails a successful callback when elevated termination is unconfirmed", async () => {
        const relay = fakeRelay();
        const originalKill = relay.process.kill;
        const process: HyperVElevatedNetworkRelayProcess = {
            ...relay.process,
            completion: Promise.resolve({ errorCode: "hyper-v-network-elevation-termination-unconfirmed" }),
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
        });
    });

    it("lets the inner child termination window settle before the outer relay fallback", async () => {
        vi.useFakeTimers();
        try {
            const relay = fakeRelay();
            let resolveCompletion = (_value: { readonly errorCode: HyperVElevatedNetworkErrorCode | null }) =>
                undefined as void;
            const completion = new Promise<{ readonly errorCode: HyperVElevatedNetworkErrorCode | null }>((resolve) => {
                resolveCompletion = resolve;
            });
            const process: HyperVElevatedNetworkRelayProcess = {
                ...relay.process,
                completion,
                close() {
                    setTimeout(() => resolveCompletion({ errorCode: null }), 5_001);
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

            await vi.advanceTimersByTimeAsync(5_001);
            await expect(result).resolves.toEqual({ status: 0, stdout: successEnvelope("Get-VM") });
        } finally {
            vi.useRealTimers();
        }
    });

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
            });
            await vi.advanceTimersByTimeAsync(10_000);
            await rejection;
        } finally {
            vi.useRealTimers();
        }
    });

    it("does not shrink termination proof after the operation deadline has elapsed", async () => {
        vi.useFakeTimers();
        try {
            const relay = fakeRelay();
            let resolveCompletion = (_value: { readonly errorCode: HyperVElevatedNetworkErrorCode | null }) =>
                undefined as void;
            const completion = new Promise<{ readonly errorCode: HyperVElevatedNetworkErrorCode | null }>((resolve) => {
                resolveCompletion = resolve;
            });
            const process: HyperVElevatedNetworkRelayProcess = {
                ...relay.process,
                completion,
                close() {
                    setTimeout(() => resolveCompletion({ errorCode: null }), 5_001);
                },
            };

            const result = withElevatedHyperVNetworkExecutor({
                executable,
                deadlineUnixMilliseconds: Date.now() + 1_000,
                spawnRelay: async (request) => {
                    request.onBeforeElevation();
                    return process;
                },
            }, async (executor) => {
                const execution = await executor.execute(getVmRequest(), executorContext());
                await new Promise<void>((resolve) => setTimeout(resolve, 6_000));
                return execution;
            });

            await vi.advanceTimersByTimeAsync(6_000);
            await vi.advanceTimersByTimeAsync(5_001);
            await expect(result).resolves.toEqual({ status: 0, stdout: successEnvelope("Get-VM") });
        } finally {
            vi.useRealTimers();
        }
    });

    it("keeps the production relay generic and pins the authentication controls", () => {
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
        expect(HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP).toContain("CopyToAsync");
        expect(HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP).toContain("$Y.WaitForExit(5000)");
        expect(HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP).not.toContain("\0");
        expect(HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP.length).toBeLessThan(8_000);
        expect(HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP.match(/-Verb RunAs/g)).toHaveLength(1);
        expect(requestIndex).toBeGreaterThanOrEqual(0);
        expect(approvalIndex).toBeGreaterThan(requestIndex);
        expect(runAsIndex).toBeGreaterThan(approvalIndex);
        expect(HYPER_V_ELEVATED_NETWORK_RELAY_BOOTSTRAP).not.toMatch(/(?:Get|New|Set|Remove)-(?:VM|Net)/);
    });

    it("sends graceful close through the relay without ending relay stdin first", () => {
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

        expect(closeStart).toBeGreaterThanOrEqual(0);
        expect(closeEnd).toBeGreaterThan(closeStart);
        expect(closeSource).toContain("child.stdin?.write(`${HYPER_V_WINDOWS_SESSION_CLOSE_MARKER}\\n`");
        expect(closeSource).not.toContain("child.stdin?.end()");
        const clearDeadline = closeSource.indexOf("clearTimeout(deadlineTimer)");
        const writeClose = closeSource.indexOf("child.stdin?.write");
        expect(clearDeadline).toBeGreaterThanOrEqual(0);
        expect(clearDeadline).toBeLessThan(writeClose);
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
