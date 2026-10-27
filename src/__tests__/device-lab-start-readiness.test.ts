import { describe, expect, it, vi } from "vitest";
import { finishStartReadiness, startBootTimeoutMs } from "../../device-lab-mcp/src/start-readiness.mjs";

const result = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const start = (backend = "macos-vm") => result({ result: { device: { id: "test-vm", backend } } });
const cursor = result({ result: { content: [{ type: "text", text: JSON.stringify({ cursor: { x: 10, y: 20 } }) }] } });
const args = { deviceId: "test-vm", waitForBoot: true, bootTimeoutMs: 1000 };

describe("start waits for configured desktop control transport", () => {
    it("retains only classified helper logs", async () => {
        let clock = 0;
        const invoke = async () => result({ ok: false, helperDiagnostic: { logEvidence: {
            bootstrapStarted: true, bootstrapReady: false, helperHeartbeat: "PRIVATE", bootstrapStderr: "parse-error", helperStderr: "PRIVATE", raw: "PRIVATE",
        } } });
        const observed = await finishStartReadiness(start(), args, 0, invoke, { now: () => clock, sleep: async (ms: number) => { clock += ms; } });
        expect(JSON.parse(observed.content[0].text).readiness.helper.logEvidence).toEqual({ bootstrapStarted: true, bootstrapReady: false, bootstrapStderr: "parse-error" });
        expect(JSON.stringify(observed)).not.toContain("PRIVATE");
    });
    it.each(["login-unavailable", "timeout", "command-failed"])("retains bounded bootstrap failure %s", async bootstrapFailure => {
        let clock = 0;
        const invoke = vi.fn(async () => result({ ok: false, helperDiagnostic: { bootstrapFailure, bootstrapDeadlineExhausted: true, stderr: "PRIVATE" } }));
        const observed = await finishStartReadiness(start(), args, 0, invoke, { now: () => clock, sleep: async (ms: number) => { clock += ms; } });
        expect(JSON.parse(observed.content[0].text).readiness.helper).toEqual({ bootstrapFailure, bootstrapDeadlineExhausted: true });
        expect(JSON.stringify(observed)).not.toContain("PRIVATE");
    });
    it.each([
        [result({ ok: false, error: "private-token", helperDiagnostic: { readyMarkerPresent: false, requestAttempted: true, requestOk: false, guestStatus: 1, stdout: "secret" } }), "provider-error"],
        [result({ ok: true }), "missing-cursor"],
    ])("retains bounded last probe evidence", async (probe, lastProbe) => {
        let clock = 500;
        const observed = await finishStartReadiness(start("windows-sandbox"), args, 0, async () => probe, {
            now: () => clock, sleep: async (ms: number) => { clock += ms; },
        });
        const value = JSON.parse(observed.content[0].text);
        expect(value.readiness).toMatchObject({ attempts: 1, lastProbe });
        if (lastProbe === "provider-error") expect(value.readiness.helper).toEqual({ readyMarkerPresent: false, requestAttempted: true, requestOk: false, guestStatus: 1 });
        expect(JSON.stringify(value)).not.toMatch(/secret|private-token|stdout/);
    });
    it.each(["sandbox-id-invalid", "prerequisites-missing", "session-connect-failed", "response-rejected", "response-timeout"])("retains the closed helper stage %s across a later provider error", async (stage) => {
        let clock = 0;
        const invoke = vi.fn().mockResolvedValueOnce(result({ ok: false, helperDiagnostic: { stage, readyMarkerPresent: false, error: "secret" } }))
            .mockResolvedValueOnce(result({ ok: false, error: "private-host-message" }));
        const observed = await finishStartReadiness(start("windows-sandbox"), args, 0, invoke, { now: () => clock, sleep: async (ms: number) => { clock += ms; } });
        expect(JSON.parse(observed.content[0].text).readiness).toEqual({ attempts: 2, lastProbe: "provider-error", helper: { stage, readyMarkerPresent: false }, helperAttempt: 1 });
        expect(JSON.stringify(observed)).not.toMatch(/secret|private-host-message/);
    });
    it("drops unknown helper stages and replaces earlier evidence with the latest valid helper observation", async () => {
        let clock = 0;
        const invoke = vi.fn().mockResolvedValueOnce(result({ ok: false, helperDiagnostic: { stage: "response-timeout", requestOk: false } }))
            .mockResolvedValueOnce(result({ ok: false, helperDiagnostic: { stage: "C:\\secret", requestOk: true } }));
        const observed = await finishStartReadiness(start(), args, 0, invoke, { now: () => clock, sleep: async (ms: number) => { clock += ms; } });
        expect(JSON.parse(observed.content[0].text).readiness).toEqual({ attempts: 2, lastProbe: "provider-error", helper: { requestOk: true }, helperAttempt: 2 });
        expect(JSON.stringify(observed)).not.toContain("secret");
    });
    it("reports when provider start consumed the whole readiness budget", async () => {
        const invoke = vi.fn();
        const observed = await finishStartReadiness(start(), args, 0, invoke, { now: () => 1000 });
        expect(JSON.parse(observed.content[0].text).readiness).toEqual({ attempts: 0, lastProbe: "not-attempted" });
        expect(invoke).not.toHaveBeenCalled();
    });
    it("retains earlier helper evidence with its attempt when the last probe throws", async () => {
        let clock = 0;
        const invoke = vi.fn().mockResolvedValueOnce(result({ ok: false, helperDiagnostic: { requestOk: false } }))
            .mockRejectedValueOnce(new Error("C:\\private token=secret"));
        const observed = await finishStartReadiness(start(), args, 0, invoke, { now: () => clock, sleep: async (ms: number) => { clock += ms; } });
        expect(JSON.parse(observed.content[0].text).readiness).toEqual({ attempts: 2, lastProbe: "transport-exception", helper: { requestOk: false }, helperAttempt: 1 });
        expect(JSON.stringify(observed)).not.toMatch(/private|secret/);
    });
    it.each(["macos-vm", "windows-sandbox"])("probes %s with explicit targeting before returning success", async backend => {
        const invoke = vi.fn(async () => cursor);
        const original = start(backend);
        expect(await finishStartReadiness(original, { ...args, implicitBroker: false }, 0, invoke, { now: () => 100 })).toBe(original);
        expect(invoke).toHaveBeenCalledWith("device_cursor_position", {
            deviceId: "test-vm", backend, implicitBroker: false, helperTimeoutMs: 900, rpcTimeoutMs: 900,
        });
    });
    it("uses one budget for start and retries, and rejects a bare successful acknowledgment", async () => {
        let clock = 600;
        const invoke = vi.fn(async (..._args: unknown[]) => result({ ok: true }));
        const observed = await finishStartReadiness(start(), args, 0, invoke, {
            now: () => clock, sleep: async (ms: number) => { clock += ms; },
        });
        expect(invoke).toHaveBeenCalledTimes(1);
        expect(invoke.mock.calls[0]?.[1]).toMatchObject({ helperTimeoutMs: 400, rpcTimeoutMs: 400 });
        expect(JSON.parse(observed.content[0].text)).toMatchObject({ error: "device-start-not-ready", detail: "control-transport-timeout" });
    });
    it("retries a transient helper failure, then accepts actual cursor observation", async () => {
        let clock = 0;
        const invoke = vi.fn().mockResolvedValueOnce(result({ ok: false, error: "helper-not-ready" })).mockResolvedValueOnce(cursor);
        const original = start();
        expect(await finishStartReadiness(original, args, 0, invoke, {
            now: () => clock, sleep: async (ms: number) => { clock += ms; },
        })).toBe(original);
        expect(invoke).toHaveBeenCalledTimes(2);
    });
    it("does not treat cursor coordinates inside an error as readiness", async () => {
        let clock = 0;
        const invoke = vi.fn(async () => result({ ok: false, error: "permission-denied", cursor: { x: 1, y: 2 } }));
        const observed = await finishStartReadiness(start(), args, 0, invoke, {
            now: () => clock, sleep: async (ms: number) => { clock += ms; },
        });
        expect(JSON.parse(observed.content[0].text).ok).toBe(false);
    });
    it("preserves asynchronous starts and other backends' existing readiness", async () => {
        const invoke = vi.fn();
        const original = start();
        expect(await finishStartReadiness(original, { ...args, waitForBoot: false }, 0, invoke)).toBe(original);
        const android = start("android-emulator");
        expect(await finishStartReadiness(android, args, 0, invoke)).toBe(android);
        expect(invoke).not.toHaveBeenCalled();
    });
    it("preserves provider failure and rejects recorded failed boot before probing", async () => {
        const invoke = vi.fn();
        const failed = result({ ok: false, error: "provider-command-failed" });
        expect(await finishStartReadiness(failed, args, 0, invoke)).toEqual({ ...failed, isError: true });
        const notReady = result({ device: { id: args.deviceId, backend: "macos-vm", bootReady: false } });
        expect(JSON.parse((await finishStartReadiness(notReady, args, 0, invoke)).content[0].text).detail).toBe("boot-readiness-failed");
        expect(invoke).not.toHaveBeenCalled();
    });
    it("supports non-Tart configured SSH when provider boot polling is skipped", async () => {
        const original = result({ device: { id: args.deviceId, backend: "macos-vm", bootReady: false, lastBootCheck: { ready: false, skipped: true } } });
        expect(await finishStartReadiness(original, args, 0, async () => cursor, { now: () => 100 })).toBe(original);
    });
    it.each(["android-emulator", "ios-simulator"])("rejects failed boot evidence from %s", async backend => {
        const original = result({ device: { id: args.deviceId, backend }, boot: { ready: false, skipped: false } });
        const observed = await finishStartReadiness(original, args, 0, vi.fn());
        expect(JSON.parse(observed.content[0].text).detail).toBe("boot-readiness-failed");
    });
    it("uses backend-specific bounded boot budgets", () => {
        expect(startBootTimeoutMs({ backend: "macos-vm" })).toBe(300000);
        expect(startBootTimeoutMs({ backend: "windows-sandbox" })).toBe(60000);
        expect(startBootTimeoutMs({ bootTimeoutMs: 9999999 })).toBe(600000);
    });
    it("bounds thrown transport failures by the same deadline", async () => {
        let clock = 500;
        const invoke = vi.fn(async () => { throw new Error("private transport output"); });
        const observed = await finishStartReadiness(start(), args, 0, invoke, {
            now: () => clock, sleep: async (ms: number) => { clock += ms; },
        });
        expect(invoke).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(observed)).not.toContain("private transport output");
        expect(JSON.parse(observed.content[0].text).detail).toBe("control-transport-timeout");
    });
    it("does not accept a control response arriving beyond the total deadline", async () => {
        let clock = 500;
        const observed = await finishStartReadiness(start(), args, 0, async () => { clock = 1001; return cursor; }, { now: () => clock });
        expect(JSON.parse(observed.content[0].text).detail).toBe("control-transport-timeout");
        expect(JSON.parse(observed.content[0].text).readiness).toEqual({ attempts: 1, lastProbe: "late-response" });
    });
    it("keeps nested boot errors visible instead of compacting them to ok", async () => {
        const original = result({ device: { id: args.deviceId, backend: "ios-simulator" }, boot: { ready: false, error: "simctl timed out" } });
        const observed = await finishStartReadiness(original, args, 0, vi.fn());
        expect(observed.isError).toBe(true);
        expect(observed.content).toEqual(original.content);
    });
    it.each(["broker", "viaBroker", "implicitBroker"])("preserves the %s direct route on the probe", async key => {
        const invoke = vi.fn(async () => cursor);
        await finishStartReadiness(start(), { ...args, [key]: false }, 0, invoke, { now: () => 100 });
        expect(invoke).toHaveBeenCalledWith("device_cursor_position", expect.objectContaining({ [key]: false }));
    });
    it("preserves explicit broker endpoint without forwarding start controls", async () => {
        const invoke = vi.fn(async (..._params: unknown[]) => cursor);
        const route = { broker: true, host: "127.0.0.1", hostCandidates: ["127.0.0.1"], port: 18000, autolaunch: false };
        await finishStartReadiness(start(), { ...args, ...route, headless: true }, 0, invoke, { now: () => 100 });
        expect(invoke).toHaveBeenCalledWith("device_cursor_position", expect.objectContaining(route));
        expect(invoke.mock.calls[0]?.[1]).not.toHaveProperty("headless");
        expect(invoke.mock.calls[0]?.[1]).not.toHaveProperty("waitForBoot");
    });
    it("does not skip control readiness when a successful start omitted its backend", async () => {
        const observed = await finishStartReadiness(result({ device: { id: args.deviceId } }), args, 0, vi.fn());
        expect(JSON.parse(observed.content[0].text).detail).toBe("missing-start-backend");
    });
});

describe("desktop readiness retains classified probe failures", () => {
    it.each([
        ["broker-process", { ok: false, error: "broker-runtime-process-unverified", launch: { attempts: [{
            processVerification: { observation: { stage: "listener", reason: "native-command-failed", status: null,
                signal: "SIGTERM", code: "ETIMEDOUT", command: "PRIVATE-COMMAND", stderr: "PRIVATE-STDERR" } },
        }] } }, { stage: "broker-process", error: "broker-runtime-process-unverified", processObservation: {
            stage: "listener", reason: "native-command-failed", status: null, signal: "SIGTERM", errorCode: "ETIMEDOUT",
        } }],
        ["broker-transport", { ok: false, error: "broker-rpc-unavailable", attempts: [{
            transportCode: "connection-refused", status: 502, error: "PRIVATE-TRANSPORT", url: "PRIVATE-ENDPOINT",
        }] }, { stage: "broker-transport", error: "broker-rpc-unavailable" }],
        ["provider", { ok: false, error: "provider-command-failed", execution: { command: {
            status: 17, signal: null, errorCode: "EACCES", stdout: "PRIVATE-OUTPUT", executable: "PRIVATE-PATH", args: ["PRIVATE-ARG"],
        } } }, { stage: "provider", error: "provider-command-failed", execution: { status: 17, signal: null, errorCode: "EACCES" } }],
    ])("preserves %s evidence and its attempt across a later unclassified response", async (_stage, failedProbe, failure) => {
        let clock = 0;
        const invoke = vi.fn().mockResolvedValueOnce(result(failedProbe))
            .mockResolvedValueOnce(result({ ok: false, error: "PRIVATE-LATER-ERROR" }));
        const observed = await finishStartReadiness(start(), args, 0, invoke, {
            now: () => clock, sleep: async (ms: number) => { clock += ms; },
        });
        expect(JSON.parse(observed.content[0].text).readiness).toEqual({
            attempts: 2, lastProbe: "provider-error", failure, failureAttempt: 1,
        });
        expect(invoke).toHaveBeenCalledTimes(2);
        expect(JSON.stringify(observed)).not.toContain("PRIVATE");
    });

    it("retains observed native failure facts without publishing an unknown error code", async () => {
        let clock = 500;
        const observed = await finishStartReadiness(start(), args, 0, async () => result({
            ok: false, error: "PRIVATE-NATIVE-ERROR", execution: {
                status: 1, signal: null, errorCode: "ENOENT", stderr: "PRIVATE-OUTPUT", command: "PRIVATE-COMMAND",
            },
        }), { now: () => clock, sleep: async (ms: number) => { clock += ms; } });
        expect(JSON.parse(observed.content[0].text).readiness).toEqual({ attempts: 1, lastProbe: "provider-error",
            failure: { stage: "provider", execution: { status: 1, signal: null, errorCode: "ENOENT" } }, failureAttempt: 1 });
        expect(JSON.stringify(observed)).not.toContain("PRIVATE");
    });

    it("classifies an observed closed transport code without publishing transport error text", async () => {
        let clock = 500;
        const observed = await finishStartReadiness(start(), args, 0, async () => result({
            ok: false, attempts: [{ transportCode: "connection-refused", error: "PRIVATE-HOST-AND-CREDENTIAL" }],
        }), { now: () => clock, sleep: async (ms: number) => { clock += ms; } });
        expect(JSON.parse(observed.content[0].text).readiness).toEqual({ attempts: 1, lastProbe: "provider-error",
            failure: { stage: "broker-transport", error: "connection-refused" }, failureAttempt: 1 });
        expect(JSON.stringify(observed)).not.toContain("PRIVATE");
    });

    it("retains the broker backend-child failure's direct native status", async () => {
        let clock = 500;
        const observed = await finishStartReadiness(start(), args, 0, async () => result({
            ok: false, error: "device-lab-backend-tool-failed", status: 9, signal: "SIGKILL", stderr: "PRIVATE-OUTPUT",
        }), { now: () => clock, sleep: async (ms: number) => { clock += ms; } });
        expect(JSON.parse(observed.content[0].text).readiness).toEqual({ attempts: 1, lastProbe: "provider-error",
            failure: { stage: "provider", error: "device-lab-backend-tool-failed", execution: { status: 9, signal: "SIGKILL" } },
            failureAttempt: 1 });
        expect(JSON.stringify(observed)).not.toContain("PRIVATE");
    });

    it("retains native backend status from the broker body instead of its HTTP status", async () => {
        let clock = 500;
        const observed = await finishStartReadiness(start(), args, 0, async () => result({
            ok: false, error: "device-lab-backend-tool-failed", status: 502,
            body: { error: "device-lab-backend-tool-failed", status: 9, signal: "SIGKILL", stderr: "PRIVATE-OUTPUT" },
        }), { now: () => clock, sleep: async (ms: number) => { clock += ms; } });
        expect(JSON.parse(observed.content[0].text).readiness).toEqual({ attempts: 1, lastProbe: "provider-error",
            failure: { stage: "provider", error: "device-lab-backend-tool-failed", execution: { status: 9, signal: "SIGKILL" } },
            failureAttempt: 1 });
        expect(JSON.stringify(observed)).not.toContain("PRIVATE");
    });

    it("reads standard structured failure content before reporting an unavailable control transport", async () => {
        let clock = 500;
        const observed = await finishStartReadiness(start(), args, 0, async () => ({
            isError: true,
            content: [{ type: "text", text: "PRIVATE-PLAIN-ERROR" }],
            structuredContent: { ok: false, error: "provider-command-failed", execution: {
                status: 111, signal: null, errorCode: "EIO", stderr: "PRIVATE-STDERR",
            } },
        }), { now: () => clock, sleep: async (ms: number) => { clock += ms; } });
        expect(JSON.parse(observed.content[0].text).readiness).toEqual({ attempts: 1, lastProbe: "provider-error",
            failure: { stage: "provider", error: "provider-command-failed", execution: { status: 111, signal: null, errorCode: "EIO" } },
            failureAttempt: 1 });
        expect(JSON.stringify(observed)).not.toContain("PRIVATE");
    });

    it.each([
        { isError: true, content: [{ type: "text", text: "PRIVATE-ERROR" }] },
        result({ ok: false, error: "private-provider-error", status: 1, signal: "SIGTERM" }),
        result({ ok: false, error: "PRIVATE-ERROR", execution: {
            status: "1", signal: "PRIVATE-SIGNAL", errorCode: "PRIVATE-CODE", stdout: "PRIVATE-OUTPUT",
        } }),
        result({ ok: false, error: "PRIVATE-ERROR", execution: { status: 0, signal: null } }),
        result({ ok: false, error: "PRIVATE-ERROR", execution: { status: null, signal: null } }),
    ])("does not invent a classified failure from unknown or malformed observations", async failedProbe => {
        let clock = 500;
        const observed = await finishStartReadiness(start(), args, 0, async () => failedProbe, {
            now: () => clock, sleep: async (ms: number) => { clock += ms; },
        });
        expect(JSON.parse(observed.content[0].text).readiness).toEqual({ attempts: 1, lastProbe: "provider-error" });
        expect(JSON.stringify(observed)).not.toMatch(/PRIVATE|private-provider/);
    });

    it("replaces an earlier classified failure with the latest classified observation", async () => {
        let clock = 0;
        const invoke = vi.fn().mockResolvedValueOnce(result({ ok: false, error: "broker-runtime-process-unverified" }))
            .mockResolvedValueOnce(result({ ok: false, error: "provider-command-failed", execution: { status: 1 } }));
        const observed = await finishStartReadiness(start(), args, 0, invoke, {
            now: () => clock, sleep: async (ms: number) => { clock += ms; },
        });
        expect(JSON.parse(observed.content[0].text).readiness).toEqual({ attempts: 2, lastProbe: "provider-error",
            failure: { stage: "provider", error: "provider-command-failed", execution: { status: 1 } }, failureAttempt: 2 });
    });

    it("keeps earlier classified failure facts when the last transport probe throws", async () => {
        let clock = 0;
        const invoke = vi.fn().mockResolvedValueOnce(result({ ok: false, error: "broker-rpc-unavailable" }))
            .mockRejectedValueOnce(new Error("PRIVATE-PATH password=PRIVATE-CREDENTIAL"));
        const observed = await finishStartReadiness(start(), args, 0, invoke, {
            now: () => clock, sleep: async (ms: number) => { clock += ms; },
        });
        expect(JSON.parse(observed.content[0].text).readiness).toEqual({ attempts: 2, lastProbe: "transport-exception",
            failure: { stage: "broker-transport", error: "broker-rpc-unavailable" }, failureAttempt: 1 });
        expect(JSON.stringify(observed)).not.toContain("PRIVATE");
    });

    it("still returns the original start after a classified failure followed by a cursor observation", async () => {
        let clock = 0;
        const invoke = vi.fn().mockResolvedValueOnce(result({ ok: false, error: "provider-command-failed" }))
            .mockResolvedValueOnce(cursor);
        const original = start();
        expect(await finishStartReadiness(original, args, 0, invoke, {
            now: () => clock, sleep: async (ms: number) => { clock += ms; },
        })).toBe(original);
        expect(invoke).toHaveBeenCalledTimes(2);
    });

    it("does not let a historical launch refusal veto a current cursor observation", async () => {
        const original = start();
        const invoke = vi.fn(async () => result({ ok: true, cursor: { x: 10, y: 20 }, launch: { attempts: [{
            error: "broker-runtime-process-unverified", processVerification: {
                observation: { stage: "listener", reason: "native-command-failed", status: null, signal: "SIGTERM", code: "ETIMEDOUT" },
            },
        }] } }));
        expect(await finishStartReadiness(original, args, 0, invoke, { now: () => 100 })).toBe(original);
        expect(invoke).toHaveBeenCalledTimes(1);
    });
});
