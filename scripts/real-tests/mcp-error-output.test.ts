import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import { parseToolPayload, parseToolResult } from "./device-lab-mcp-client.ts";
import { nestedDiagnostic } from "./nested-hyper-v.ts";
vi.mock("fs", { spy: true });

const written: string[] = [];
afterEach(() => {
    vi.restoreAllMocks();
    for (const file of written.splice(0)) fs.rmSync(file, { force: true });
});
function capture(value: unknown): any {
    try { parseToolPayload({ isError: true, content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] }); }
    catch (error) { return error; }
    throw new Error("expected failure");
}
function captureToolResultFailure(result: unknown, options: Record<string, unknown>): any {
    try { parseToolResult(result, options); }
    catch (error) {
        if (error instanceof Error) {
            const file = error.message.split("Diagnostics: ")[1];
            if (file) written.push(file);
        }
        return error;
    }
    throw new Error("expected tool result failure");
}
describe("MCP error output", () => {
    it("saves native structured evidence while excluding the original plain error text", () => {
        let caught: any;
        try {
            parseToolPayload({ isError: true, content: [{ type: "text", text: "Error: PRIVATE-RAW-OUTPUT" }],
                structuredContent: { ok: false, error: "provider-command-failed", execution: {
                    status: null, signal: "SIGTERM", timedOut: true, errorCode: "ETIMEDOUT", diagnosticCode: "native-timeout",
                    stderr: "PRIVATE-STDERR", command: "PRIVATE-COMMAND", args: ["PRIVATE-ARG"],
                } }, __cccToolCallRecord: { name: "exec" } });
        } catch (error) { caught = error; }
        expect(caught).toBeInstanceOf(Error);
        const file = caught.message.split("Diagnostics: ")[1];
        written.push(file);
        const saved = fs.readFileSync(file, "utf8");
        expect(JSON.parse(saved).failure.execution).toEqual({ status: null, signal: "SIGTERM", timedOut: true,
            errorCode: "ETIMEDOUT", diagnosticCode: "native-timeout" });
        expect(caught.message).toContain("native-timeout");
        expect(caught.message + saved).not.toContain("PRIVATE");
    });

    it("projects only bounded simctl failure facts into real artifacts and short errors", () => {
        const errors = [
            { domain: "NSPOSIXErrorDomain", code: 2, detail: "PRIVATE-DETAIL" },
            { domain: "PRIVATE-DOMAIN", code: 99 },
            { domain: "NSCocoaErrorDomain", code: "4" },
            { domain: "NSCocoaErrorDomain", code: -2147483649 },
            { domain: "com.apple.CoreSimulator.SimError", code: 2147483648 },
            { domain: "NSPOSIXErrorDomain", code: 1.5 },
            { domain: "NSCocoaErrorDomain", code: -2147483648 },
            { domain: "com.apple.CoreSimulator.SimError", code: 2147483647 },
            { domain: "NSPOSIXErrorDomain", code: 0 },
            { domain: "NSCocoaErrorDomain", code: 13 },
        ];
        const selectedErrors = [
            { domain: "NSPOSIXErrorDomain", code: 2 },
            { domain: "NSCocoaErrorDomain", code: -2147483648 },
            { domain: "com.apple.CoreSimulator.SimError", code: 2147483647 },
            { domain: "NSPOSIXErrorDomain", code: 0 },
        ];
        for (const stage of ["spawn", "PRIVATE-STAGE"]) {
            let caught: any;
            try {
                parseToolPayload({ isError: true, content: [{ type: "text", text: "PRIVATE-RAW-OUTPUT" }],
                    structuredContent: { ok: false, error: "provider-command-failed", execution: {
                        status: 111, signal: null, timedOut: false, diagnosticCode: "native-nonzero-exit",
                        simctl: { stage, errors, stderr: "PRIVATE-STDERR", args: ["PRIVATE-ARG"] },
                    } }, __cccToolCallRecord: { name: "exec" } });
            } catch (error) { caught = error; }
            expect(caught).toBeInstanceOf(Error);
            const file = caught.message.split("Diagnostics: ")[1];
            written.push(file);
            const saved = fs.readFileSync(file, "utf8");
            expect(JSON.parse(saved).failure.execution.simctl).toEqual({
                errors: selectedErrors,
                ...(stage === "spawn" ? { stage: "spawn" } : {}),
            });
            expect(caught.message).toContain("NSPOSIXErrorDomain");
            expect(caught.message).toContain('"code":2');
            expect(caught.message + saved).not.toContain("PRIVATE");
        }
    });

    it.each([null, [], {}, "PRIVATE"])("uses JSON content when structured failure metadata is invalid: %s", structuredContent => {
        let caught: any;
        try { parseToolPayload({ isError: true, content: [{ type: "text", text: '{"ok":false,"error":"device-not-found"}' }], structuredContent }); }
        catch (error) { caught = error; }
        written.push(caught.message.split("Diagnostics: ")[1]);
        expect(caught.message).toContain("device-not-found");
        expect(caught.message).not.toContain("PRIVATE");
    });

    it("persists an unexpected internal broker failure before an assertion can truncate it", () => {
        const payload = { ok: false, error: "broker-runtime-process-unverified", launch: {
            attempts: [{ processVerification: { source: "unverified-broker-port-process", observation: {
                stage: "start-token", reason: "native-command-failed", status: 1, signal: null, code: null, stderr: "PRIVATE-STDERR",
            } } }],
        } };
        const result = { content: [{ type: "text", text: JSON.stringify(payload) }], __cccToolCallRecord: {} };
        let caught: any;
        try { parseToolResult(result, { expectedError: true, expectedErrorCode: "owner-device-not-found" }); }
        catch (error) { caught = error; }
        expect(caught.message).toContain("broker-runtime-process-unverified");
        const file = caught.message.split("Diagnostics: ")[1];
        written.push(file);
        const saved = fs.readFileSync(file, "utf8");
        expect(JSON.parse(saved).failure.processObservation).toMatchObject({ stage: "start-token", reason: "native-command-failed", status: 1 });
        expect(saved).not.toContain("PRIVATE");
        expect(result.__cccToolCallRecord).not.toHaveProperty("expectedError");
        expect(parseToolResult({ content: [{ type: "text", text: '{"ok":false,"error":"owner-device-not-found"}' }] },
            { expectedError: true, expectedErrorCode: "owner-device-not-found" })).toEqual({ ok: false, error: "owner-device-not-found" });
    });

    describe("exact public missing-target expectations", () => {
        const expectedErrorCodes = ["device-not-found", "device-backend-not-found"];

        it.each(expectedErrorCodes)("accepts and marks the exact expected error %s", error => {
            const payload = { ok: false, error, deviceId: "fixture-missing-device" };
            const result = { isError: true, content: [{ type: "text", text: JSON.stringify(payload) }], __cccToolCallRecord: {} };

            expect(parseToolResult(result, { expectedError: true, expectedErrorCodes })).toEqual(payload);
            expect(result.__cccToolCallRecord).toEqual({ expectedError: true });
        });

        it("saves an unexpected public broker refusal with selected process evidence and leaves it unmarked", () => {
            const payload = { ok: false, error: "broker-runtime-process-unverified", token: "PRIVATE-TOKEN", launch: {
                attempts: [{ processVerification: { observation: {
                    stage: "command", reason: "native-command-failed", status: 1, signal: null, code: "EACCES",
                    stderr: "PRIVATE-STDERR", command: "PRIVATE-COMMAND", pid: 12345,
                } } }],
            } };
            const result = { isError: true, content: [{ type: "text", text: JSON.stringify(payload) }], __cccToolCallRecord: { name: "stop" } };

            const error = captureToolResultFailure(result, { expectedError: true, expectedErrorCodes });

            expect(error).toBeInstanceOf(Error);
            expect(error.message).toContain("broker-runtime-process-unverified");
            expect(error.message).toContain("Diagnostics: results/device-lab-real/mcp-error-");
            expect(error.brokerPayload).toEqual(payload);
            expect(result.__cccToolCallRecord).not.toHaveProperty("expectedError");
            const saved = fs.readFileSync(error.message.split("Diagnostics: ")[1], "utf8");
            expect(JSON.parse(saved).failure.processObservation).toEqual({
                stage: "command", reason: "native-command-failed", status: 1, signal: null, errorCode: "EACCES",
            });
            expect(saved + error.message).not.toContain("PRIVATE");
            expect(saved).not.toContain("12345");
        });

        it.each([
            { ok: true, deviceId: "fixture-missing-device" },
            { ok: true, error: "device-not-found" },
            { ok: false },
            { ok: false, error: "device-not-found-extra" },
        ])("rejects a successful or nonmatching payload without marking it expected: %j", payload => {
            const result = { isError: payload.ok === false, content: [{ type: "text", text: JSON.stringify(payload) }], __cccToolCallRecord: {} };

            const error = captureToolResultFailure(result, { expectedError: true, expectedErrorCodes });

            expect(error).toBeInstanceOf(Error);
            expect(error.message).toContain("Diagnostics: results/device-lab-real/mcp-error-");
            expect(result.__cccToolCallRecord).not.toHaveProperty("expectedError");
            expect(fs.existsSync(error.message.split("Diagnostics: ")[1])).toBe(true);
        });

        it("preserves the original public refusal if its diagnostic write fails", () => {
            const payload = { ok: false, error: "broker-runtime-process-unverified" };
            const result = { isError: true, content: [{ type: "text", text: JSON.stringify(payload) }], __cccToolCallRecord: {} };
            vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => { throw new Error("PRIVATE-WRITE-ERROR"); });

            const error = captureToolResultFailure(result, { expectedError: true, expectedErrorCodes });

            expect(error).toBeInstanceOf(Error);
            expect(error.message).toContain("broker-runtime-process-unverified");
            expect(error.message).toContain("Diagnostics could not be saved");
            expect(error.message).not.toContain("PRIVATE");
            expect(error.brokerPayload).toEqual(payload);
            expect(result.__cccToolCallRecord).not.toHaveProperty("expectedError");
        });

        it("preserves singleton matching and refuses other codes", () => {
            const payload = { ok: false, error: "owner-device-not-found" };
            const accepted = { isError: true, content: [{ type: "text", text: JSON.stringify(payload) }], __cccToolCallRecord: {} };
            const rejected = { isError: true, content: [{ type: "text", text: '{"ok":false,"error":"device-not-found"}' }], __cccToolCallRecord: {} };

            expect(parseToolResult(accepted, { expectedError: true, expectedErrorCode: "owner-device-not-found" })).toEqual(payload);
            expect(accepted.__cccToolCallRecord).toEqual({ expectedError: true });
            const error = captureToolResultFailure(rejected, { expectedError: true, expectedErrorCode: "owner-device-not-found" });
            expect(error.message).toContain("device-not-found");
            expect(error.message).toContain("Diagnostics: results/device-lab-real/mcp-error-");
            expect(rejected.__cccToolCallRecord).not.toHaveProperty("expectedError");
        });
    });

    it("reduces repeated broker state to a short actionable error and sanitized diagnostic file", () => {
        const attempts = Array.from({ length: 40 }, () => ({ error: "timeout", host: "PRIVATE-HOST", durationMs: 261 }));
        const value = { ok: false, error: "broker-runtime-process-unverified", token: "SECRET", attempts: [...attempts, {
            reason: "runtime-health-check-failed", attempts,
            termination: { reason: "unverified-broker-port-process" },
        }],
            launch: { runtime: { commandLine: "PRIVATE-PATH" }, attempts } };
        const error = capture(value);
        expect(error.message.length).toBeLessThan(400);
        expect(error.message).toContain("automatic restart was refused");
        expect(error.message.length).toBeLessThanOrEqual(240);
        expect(error.brokerPayload).toEqual(value);
        expect(Object.keys(error)).not.toContain("brokerPayload");
        const file = error.message.split("Diagnostics: ")[1];
        written.push(file);
        const saved = fs.readFileSync(file, "utf8");
        expect(JSON.parse(saved).failure.error).toBe(value.error);
        expect(JSON.parse(saved).failure.recovery).toEqual({ reason: "runtime-health-check-failed", probeCount: 40,
            lastProbeError: "timeout", terminationReason: "unverified-broker-port-process" });
        for (const secret of ["SECRET", "PRIVATE-PATH", "PRIVATE-HOST"]) {
            expect(error.message).not.toContain(secret);
            expect(saved).not.toContain(secret);
        }
    });
    it("keeps the primary failure when saving diagnostics fails", () => {
        vi.spyOn(fs, "writeFileSync").mockImplementation(() => { throw new Error("PRIVATE-WRITE-ERROR"); });
        const error = capture({ ok: false, error: "device-not-found" });
        expect(error.message).toContain("device-not-found");
        expect(error.message).toContain("Diagnostics could not be saved");
        expect(error.message).not.toContain("PRIVATE");
    });
    it("does not echo non-JSON error bodies", () => {
        vi.spyOn(fs, "writeFileSync").mockImplementation(() => {});
        expect(capture("PRIVATE-RAW-OUTPUT\n".repeat(1000)).message).toMatch(/^mcp-tool-failed:|^mcp-tool-failed Diagnostics:/);
        expect(capture("PRIVATE-RAW-OUTPUT").message).not.toContain("PRIVATE");
    });
    it("preserves successful responses", () => {
        expect(parseToolPayload({ content: [{ type: "text", text: '{"ok":true,"devices":[]}' }] })).toEqual({ ok: true, devices: [] });
    });
    it("preserves broker codes and readiness evidence for the nested runner", () => {
        vi.spyOn(fs, "writeFileSync").mockImplementation(() => {});
        const unavailable = capture({ ok: false, error: "host-broker-unavailable" });
        expect(nestedDiagnostic(unavailable).code).toBe("host-broker-unavailable");
        const readiness = capture({ ok: false, error: "hyper-v-guest-not-ready", result: {
            boot: { guestReadiness: { ready: false, diagnosticError: "hyper-v-powershell-direct-unavailable" } },
        } });
        const evidence = nestedDiagnostic(readiness, { ok: true });
        expect(evidence.code).toBe("hyper-v-guest-not-ready");
        expect(JSON.stringify(evidence)).toContain("hyper-v-powershell-direct-unavailable");
    });
});
