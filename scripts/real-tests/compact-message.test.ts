import { describe, expect, it } from "vitest";
import { compactMessage } from "./compact-message.ts";

describe("compactMessage", () => {
    it("returns a bounded (<=511) guest diagnostic reason in full so the actionable tail survives", () => {
        // Mirrors the Hyper-V E2E FAIL reason: "<step>: <formatBrokerToolFailure output (<=511)>".
        const bootDiagnostic = `boot={"provider":"hyper-v-powershell-direct","error":"powershell-direct-session-unavailable","state":"Running","uptimeMs":1201850,"generation":2,"secureBoot":true,"heartbeat":null,"heartbeatStatus":[null,null],"diagnosticComplete":false,"diagnosticErrors":["hyper-v-diagnostic-integration-services-unavailable"],"services":[["Heartbeat",false,2],["Key-Value Pair Exchange",true,2]],"disks":1,"dvds":1}`;
        const reason = `start and wait for PowerShell Direct: hyper-v-guest-not-ready: ${bootDiagnostic}`;
        expect(reason.length).toBeLessThanOrEqual(511 + 64); // step prefix + bounded diagnostic
        const compacted = compactMessage(reason);
        expect(compacted).toBe(reason);
        expect(compacted).toContain('"diagnosticErrors":["hyper-v-diagnostic-integration-services-unavailable"]');
        expect(compacted).toContain('"services":[["Heartbeat",false,2]');
    });

    it("truncates strings beyond the limit with a trailing ellipsis", () => {
        const long = "x".repeat(900);
        const compacted = compactMessage(long);
        expect(compacted.length).toBe(700);
        expect(compacted.endsWith("...")).toBe(true);
    });

    it("honors an explicit limit", () => {
        expect(compactMessage("abcdefghij", 5)).toBe("ab...");
    });

    it("normalizes whitespace and defaults empty input", () => {
        expect(compactMessage("  a\n\t b  ")).toBe("a b");
        expect(compactMessage("")).toBe("unknown error");
        expect(compactMessage(null)).toBe("unknown error");
    });
});
