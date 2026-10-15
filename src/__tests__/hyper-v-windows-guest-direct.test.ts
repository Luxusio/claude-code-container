import { afterEach, describe, expect, it, vi } from "vitest";

import { createHyperVGuestDirectClient, type HyperVWindowsExecutionRequest } from "@ccc/hyper-v/index.js";
import { invokeDeviceLabHyperVGuestDirect } from "@ccc/device-lab/device-lab/broker/hyper-v/guest-direct-adapter.js";

const identity = {
    selector: { kind: "id" as const, id: "12345678-1234-1234-1234-123456789abc" },
    expectedName: "owned-vm",
    expectedNotes: "owner-marker",
    credentialPath: "C:\\private\\guest.credential.xml",
};

function success(request: HyperVWindowsExecutionRequest, items: unknown[]) {
    return { status: 0, stdout: JSON.stringify({ schemaVersion: 1, operation: request.operation, ok: true, items }) };
}

function decodeRequest(command: { input?: string }): HyperVWindowsExecutionRequest {
    const envelope = JSON.parse(Buffer.from(command.input || "", "base64").toString("utf8")) as { input: string };
    return JSON.parse(envelope.input) as HyperVWindowsExecutionRequest;
}

function guestSuccess(request: HyperVWindowsExecutionRequest) {
    if (request.operation !== "Invoke-Guest") throw new Error("unexpected-guest-operation");
    if (request.action === "mkdir") return success(request, [{ action: "mkdir" }]);
    if (request.action === "upload") return success(request, [{ ...upload, bytes: 6 }]);
    return success(request, [{ action: "exec", status: 0, stdout: "ok", stderr: "" }]);
}

const upload = { action: "upload" as const, localPath: "C:\\stage\\upload.tmp", remotePath: "C:\\target\\file.txt" };

afterEach(() => vi.restoreAllMocks());

describe("typed Hyper-V PowerShell Direct", () => {
    it("rejects malformed identity, command, paths, limits and extra fields before execution", async () => {
        const execute = vi.fn(() => success({ schemaVersion: 1, operation: "Invoke-Guest", ...identity, action: "mkdir", remotePath: "C:\\x" }, []));
        const client = createHyperVGuestDirectClient({ execute });
        const valid = { ...identity, action: "exec" as const, command: "whoami" };
        await expect(client.invoke({ ...valid, selector: { kind: "id", id: "wrong" } }, 1000)).rejects.toMatchObject({ category: "validation" });
        await expect(client.invoke({ ...valid, credentialPath: "relative.xml" }, 1000)).rejects.toMatchObject({ category: "validation" });
        await expect(client.invoke({ ...valid, command: "\0" }, 1000)).rejects.toMatchObject({ category: "validation" });
        await expect(client.invoke({ ...identity, action: "download", localPath: "C:\\stage", remotePath: "C:\\file", maxBytes: 16 * 1024 * 1024 + 1 }, 1000)).rejects.toMatchObject({ category: "validation" });
        await expect(client.invoke({ ...valid, extra: true } as typeof valid, 1000)).rejects.toMatchObject({ category: "validation" });
        expect(execute).not.toHaveBeenCalled();
    });

    it("accepts guest nonzero exit as a completed typed result and rejects malformed replies", async () => {
        const execute = vi.fn((request: HyperVWindowsExecutionRequest) => success(request, [{ action: "exec", status: 7, stdout: "", stderr: "failed" }]));
        const client = createHyperVGuestDirectClient({ execute });
        await expect(client.invoke({ ...identity, action: "exec", command: "exit 7" }, 1000)).resolves.toEqual({ action: "exec", status: 7, stdout: "", stderr: "failed" });
        execute.mockImplementation((request) => success(request, [{ action: "exec", status: 0, stdout: "", stderr: "", leaked: true }]));
        await expect(client.invoke({ ...identity, action: "exec", command: "whoami" }, 1000)).rejects.toMatchObject({ category: "protocol" });
    });

    it("accepts literal Windows bracket characters in an owner-private credential path", async () => {
        const execute = vi.fn((request: HyperVWindowsExecutionRequest) => success(request, [{ action: "exec", status: 0, stdout: "ok", stderr: "" }]));
        const client = createHyperVGuestDirectClient({ execute });
        await expect(client.invoke({ ...identity, credentialPath: "C:\\Users\\Alice [Org]\\guest.xml", action: "exec", command: "whoami" }, 1000)).resolves.toMatchObject({ status: 0 });
    });

    it("does not replay an invocation after a lost response", async () => {
        const execute = vi.fn(() => ({ status: null, stdout: "", error: "connection-lost" }));
        const client = createHyperVGuestDirectClient({ execute });
        await expect(client.invoke({ ...identity, action: "exec", command: "whoami" }, 1000)).rejects.toMatchObject({ category: "transport" });
        expect(execute).toHaveBeenCalledTimes(1);
    });

    it("decodes a bounded PowerShell Direct job probe and rejects extra fields", async () => {
        const execute = vi.fn((request: HyperVWindowsExecutionRequest) => success(request, [{ action: "job", output: "{\"ready\":false}" }]));
        const client = createHyperVGuestDirectClient({ execute });
        await expect(client.invoke({ ...identity, action: "job", command: "Write-Output '{}'" }, 20000)).resolves.toEqual({ action: "job", output: "{\"ready\":false}" });
        execute.mockImplementation((request) => success(request, [{ action: "job", output: "{}", extra: true }]));
        await expect(client.invoke({ ...identity, action: "job", command: "Write-Output '{}'" }, 20000)).rejects.toMatchObject({ category: "protocol" });
    });

    it("orders remote directory creation before upload and uses one-shot requests", async () => {
        const requests: HyperVWindowsExecutionRequest[] = [];
        const run = vi.fn((command: { input?: string }) => {
            const envelope = JSON.parse(Buffer.from(command.input || "", "base64").toString("utf8")) as { input: string };
            const request = JSON.parse(envelope.input) as HyperVWindowsExecutionRequest;
            requests.push(request);
            return success(request, [request.operation === "Invoke-Guest" && request.action === "mkdir"
                ? { action: "mkdir" }
                : { action: "upload", localPath: "C:\\stage\\upload.tmp", remotePath: "C:\\target\\file.txt", bytes: 6 }]);
        });
        await expect(invokeDeviceLabHyperVGuestDirect({
            executable: "powershell.exe",
            timeoutMilliseconds: 30000,
            run,
            identity,
            action: { action: "upload", localPath: "C:\\stage\\upload.tmp", remotePath: "C:\\target\\file.txt" },
        })).resolves.toMatchObject({ action: "upload", bytes: 6 });
        expect(requests.map((request) => request.operation === "Invoke-Guest" ? request.action : "wrong")).toEqual(["mkdir", "upload"]);
    });

    it.each([
        { clock: "injected", wallDelta: -9_000_000 },
        { clock: "injected", wallDelta: 9_000_000 },
        { clock: "default", wallDelta: -9_000_000 },
        { clock: "default", wallDelta: 9_000_000 },
    ])("shares the $clock monotonic upload allowance across a wall jump of $wallDelta ms", async ({ clock, wallDelta }) => {
        let monotonic = 100.25;
        const wall = vi.spyOn(Date, "now").mockReturnValue(10_000_000);
        if (clock === "default") vi.spyOn(performance, "now").mockImplementation(() => monotonic);
        const calls: { request: HyperVWindowsExecutionRequest; timeoutMs: number }[] = [];
        const run = vi.fn((command: { input?: string }, options: { timeoutMs: number }) => {
            const request = decodeRequest(command);
            calls.push({ request, timeoutMs: options.timeoutMs });
            if (request.operation === "Invoke-Guest" && request.action === "mkdir") {
                monotonic = 111.75;
                wall.mockReturnValue(10_000_000 + wallDelta);
            }
            return guestSuccess(request);
        });

        await expect(invokeDeviceLabHyperVGuestDirect({
            executable: "powershell.exe", timeoutMilliseconds: 1000, run, identity, action: upload,
            ...(clock === "injected" ? { now: () => monotonic } : {}),
        })).resolves.toEqual({ ...upload, bytes: 6 });

        expect(calls.map(({ request }) => request.operation === "Invoke-Guest" ? request.action : "wrong")).toEqual(["mkdir", "upload"]);
        expect(calls.map(({ timeoutMs }) => timeoutMs)).toEqual([1000, 988]);
        expect(calls.every(({ timeoutMs }) => Number.isSafeInteger(timeoutMs) && timeoutMs > 0)).toBe(true);
        expect(calls.every(({ request }) => request.operation === "Invoke-Guest"
            && request.credentialPath === identity.credentialPath && request.selector.id === identity.selector.id)).toBe(true);
        expect(run).toHaveBeenCalledTimes(2);
    });

    it.each([999.25, 1000])("refuses upload when mkdir consumes %s ms of its 1000 ms allowance", async (elapsed) => {
        let monotonic = 100.25;
        const requests: HyperVWindowsExecutionRequest[] = [];
        const run = vi.fn((command: { input?: string }) => {
            const request = decodeRequest(command);
            requests.push(request);
            monotonic += elapsed;
            return guestSuccess(request);
        });

        await expect(invokeDeviceLabHyperVGuestDirect({
            executable: "powershell.exe", timeoutMilliseconds: 1000, now: () => monotonic,
            run, identity, action: upload,
        })).rejects.toMatchObject({ code: "hyper-v-operation-deadline-exceeded" });
        expect(requests.map((request) => request.operation === "Invoke-Guest" ? request.action : "wrong")).toEqual(["mkdir"]);
        expect(run).toHaveBeenCalledTimes(1);
    });

    it("preserves local callback expiry before any native dispatch", async () => {
        let monotonic = 100.25;
        let reads = 0;
        const timeoutMilliseconds = () => {
            if (reads++ > 0) monotonic = 1100.25;
            return 1000;
        };
        const run = vi.fn((command: { input?: string }) => guestSuccess(decodeRequest(command)));

        await expect(invokeDeviceLabHyperVGuestDirect({
            executable: "powershell.exe", timeoutMilliseconds, now: () => monotonic,
            run, identity, action: { action: "exec", command: "whoami" },
        })).rejects.toMatchObject({ code: "hyper-v-operation-deadline-exceeded" });
        expect(reads).toBeGreaterThan(1);
        expect(run).not.toHaveBeenCalled();
    });

    it.each(["exec", "upload"] as const)("refuses a late fulfilled final %s result without replay", async (action) => {
        let monotonic = 100.25;
        const requests: HyperVWindowsExecutionRequest[] = [];
        const run = vi.fn((command: { input?: string }) => {
            const request = decodeRequest(command);
            requests.push(request);
            if (request.operation === "Invoke-Guest" && request.action === action) monotonic = 1100.25;
            return Promise.resolve(guestSuccess(request));
        });

        await expect(invokeDeviceLabHyperVGuestDirect({
            executable: "powershell.exe", timeoutMilliseconds: 1000, now: () => monotonic,
            run, identity, action: action === "upload" ? upload : { action: "exec", command: "whoami" },
        })).rejects.toMatchObject({ code: "hyper-v-operation-deadline-exceeded" });
        expect(requests.map((request) => request.operation === "Invoke-Guest" ? request.action : "wrong")).toEqual(action === "upload" ? ["mkdir", "upload"] : ["exec"]);
    });

    it("preserves a completed guest exec failure received after expiry without replay", async () => {
        let monotonic = 100.25;
        const completed = { action: "exec", status: 7, stdout: "partial output", stderr: "guest command failed" };
        const run = vi.fn((command: { input?: string }) => {
            const request = decodeRequest(command);
            monotonic = 1100.25;
            return success(request, [completed]);
        });

        await expect(invokeDeviceLabHyperVGuestDirect({
            executable: "powershell.exe", timeoutMilliseconds: 1000, now: () => monotonic,
            run, identity, action: { action: "exec", command: "exit 7" },
        })).resolves.toEqual(completed);
        expect(run).toHaveBeenCalledTimes(1);
    });

    it("allows a dynamic timeout to shorten but never renew the original allowance", async () => {
        let monotonic = 100.25;
        let reducedBudgetRead = false;
        let mkdirCompleted = false;
        const timeouts: number[] = [];
        const timeoutMilliseconds = () => {
            if (mkdirCompleted && !reducedBudgetRead) {
                reducedBudgetRead = true;
                return 100;
            }
            return 1000;
        };
        const run = vi.fn((command: { input?: string }, options: { timeoutMs: number }) => {
            const request = decodeRequest(command);
            timeouts.push(options.timeoutMs);
            if (request.operation === "Invoke-Guest" && request.action === "mkdir") {
                monotonic = 125.75;
                mkdirCompleted = true;
            }
            return guestSuccess(request);
        });

        await expect(invokeDeviceLabHyperVGuestDirect({
            executable: "powershell.exe", timeoutMilliseconds, now: () => monotonic, run, identity, action: upload,
        })).resolves.toMatchObject({ action: "upload", bytes: 6 });
        expect(reducedBudgetRead).toBe(true);
        expect(timeouts).toEqual([1000, 100]);
        expect(run).toHaveBeenCalledTimes(2);
    });

    it.each([1.5, NaN, Infinity, 0, -1, 300001])("retains initial typed timeout validation for %s", async (timeout) => {
        for (const timeoutMilliseconds of [timeout, () => timeout]) {
            const run = vi.fn((command: { input?: string }) => guestSuccess(decodeRequest(command)));
            await expect(invokeDeviceLabHyperVGuestDirect({
                executable: "powershell.exe", timeoutMilliseconds, now: () => 100.25,
                run, identity, action: upload,
            })).rejects.toMatchObject({ category: "validation", operation: "Invoke-Guest", code: "guest-timeout-invalid" });
            expect(run).not.toHaveBeenCalled();
        }
    });

    it.each([
        { failure: "native", category: "native", code: "guest-access-denied" },
        { failure: "malformed", category: "protocol", code: "response-malformed" },
        { failure: "guest-shape", category: "protocol", code: "guest-result-invalid" },
        { failure: "timeout", category: "transport", code: "timeout" },
        { failure: "lost", category: "transport", code: "executor-failed" },
        { failure: "throw", category: "transport", code: "executor-failed" },
    ])("preserves an actual $failure failure after expiry instead of replacing or replaying it", async ({ failure, category, code }) => {
        let monotonic = 100.25;
        const run = vi.fn((command: { input?: string }) => {
            const request = decodeRequest(command);
            monotonic = 1100.25;
            if (failure === "native") return {
                status: 1,
                stdout: JSON.stringify({ schemaVersion: 1, operation: request.operation, ok: false, errorCode: code, nativeHResult: -2147024891 }),
            };
            if (failure === "malformed") return { status: 0, stdout: "not-json" };
            if (failure === "guest-shape") return success(request, [{ action: "exec", status: 0, stdout: "", stderr: "", leaked: true }]);
            if (failure === "timeout") return { status: null, stdout: "", timedOut: true };
            if (failure === "throw") throw new Error("native-runner-failed");
            return { status: null, stdout: "", error: "connection-lost" };
        });

        await expect(invokeDeviceLabHyperVGuestDirect({
            executable: "powershell.exe", timeoutMilliseconds: 1000, now: () => monotonic,
            run, identity, action: { action: "exec", command: "whoami" },
        })).rejects.toMatchObject({ category, operation: "Invoke-Guest", code });
        expect(run).toHaveBeenCalledTimes(1);
    });

    it("does not treat an unrelated timeout callback failure as its own deadline refusal", async () => {
        let monotonic = 100.25;
        let reads = 0;
        const timeoutMilliseconds = () => {
            if (reads++ > 0) {
                monotonic = 1100.25;
                throw new Error("caller-timeout-unavailable");
            }
            return 1000;
        };
        const run = vi.fn((command: { input?: string }) => guestSuccess(decodeRequest(command)));

        await expect(invokeDeviceLabHyperVGuestDirect({
            executable: "powershell.exe", timeoutMilliseconds, now: () => monotonic,
            run, identity, action: { action: "exec", command: "whoami" },
        })).rejects.toMatchObject({ category: "transport", operation: "Invoke-Guest", code: "executor-failed" });
        expect(run).not.toHaveBeenCalled();
    });
});
