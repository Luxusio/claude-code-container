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
