import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { brokerToolFailureEvidence, formatBrokerToolFailure, parseToolPayload } from "./device-lab-mcp-client.ts";
import { repoRoot } from "./helpers.ts";

const written: string[] = [];
afterEach(() => { for (const file of written.splice(0)) rmSync(file, { force: true }); });

function savedFailure(message: string, name?: string) {
    try {
        parseToolPayload({ isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, error: message }) }],
            ...(name !== undefined ? { __cccToolCallRecord: { name, arguments: { password: "PRIVATE-ARGUMENT" }, secret: "PRIVATE-RECORD" } } : {}) });
    } catch (caught) {
        const error = caught as Error;
        const relative = error.message.split("Diagnostics: ")[1];
        expect(relative).toMatch(/^results\/device-lab-real\/mcp-error-[a-f0-9-]+\.json$/);
        const path = join(repoRoot, relative);
        written.push(path);
        return { message: error.message, saved: readFileSync(path, "utf8") };
    }
    throw new Error("expected tool failure");
}

describe("saved provider failure evidence", () => {
    it.each(["absent", "empty", "access-denied", "path-not-found", "script-policy", "parse-error", "other-error", "unreadable", "oversized"])("retains classified helper logs %s without text", bootstrapStderr => {
        const logEvidence = { bootstrapStarted: true, bootstrapReady: false, helperHeartbeat: false, bootstrapStderr, helperStderr: "other-error", raw: "PRIVATE" };
        const evidence = brokerToolFailureEvidence({ readiness: { attempts: 1, lastProbe: "provider-error", helper: { logEvidence } } });
        expect(evidence.readiness).toMatchObject({ helper: { logEvidence: { bootstrapStarted: true, bootstrapReady: false, helperHeartbeat: false, bootstrapStderr, helperStderr: "other-error" } } });
        expect(JSON.stringify(evidence)).not.toContain("PRIVATE");
        expect(brokerToolFailureEvidence({ readiness: { attempts: 1, lastProbe: "provider-error", helper: { logEvidence: { bootstrapStderr: "PRIVATE", bootstrapStarted: "PRIVATE" } } } }).readiness).not.toHaveProperty("helper");
    });

    it.each(["login-unavailable", "timeout", "command-failed"])("preserves bounded bootstrap failure %s", bootstrapFailure => {
        const readiness = { attempts: 2, lastProbe: "provider-error", helperAttempt: 1,
            helper: { bootstrapFailure, bootstrapDeadlineExhausted: true, stderr: "PRIVATE" } };
        expect(brokerToolFailureEvidence({ readiness }).readiness).toEqual({ ...readiness,
            helper: { bootstrapFailure, bootstrapDeadlineExhausted: true } });
        expect(formatBrokerToolFailure({ readiness }, "failed")).toContain(bootstrapFailure);
        expect(JSON.stringify(brokerToolFailureEvidence({ readiness }))).not.toContain("PRIVATE");
        expect(brokerToolFailureEvidence({ readiness: { ...readiness, helper: { bootstrapFailure: "PRIVATE", bootstrapDeadlineExhausted: "PRIVATE" } } }).readiness)
            .not.toHaveProperty("helper");
    });

    it.each([undefined, "window_list"])("preserves known validation evidence through actual error artifacts, record=%s", name => {
        const { message, saved } = savedFailure("window_list does not support appId", name);
        expect(JSON.parse(saved).failure).toMatchObject({ validation: { kind: "unsupported-argument", tool: "window_list", field: "appId" } });
        expect(message).toContain("validation=unsupported-argument: tool=window_list: field=appId");
        if (name) expect(JSON.parse(saved).failure.tool).toBe(name);
        else expect(JSON.parse(saved).failure).not.toHaveProperty("tool");
        expect(message + saved).not.toMatch(/PRIVATE-ARGUMENT|PRIVATE-RECORD|password/);
    });
    it.each([
        "window_list does not support PRIVATE-FIELD",
        "private_tool does not support appId",
        "window_list does not support appId PRIVATE-SUFFIX",
        "window_list does not support appId\n",
    ])("does not preserve arbitrary validation text: %s", raw => {
        const { message, saved } = savedFailure(raw, "private_tool");
        expect(JSON.parse(saved).failure).not.toHaveProperty("validation");
        expect(JSON.parse(saved).failure).not.toHaveProperty("tool");
        expect(message + saved).not.toMatch(/PRIVATE|private_tool|appId/);
    });
    it("adds only the catalog-approved call identity to ordinary provider errors", () => {
        const { message, saved } = savedFailure("device-not-found", "window_list");
        expect(JSON.parse(saved).failure).toMatchObject({ tool: "window_list", error: "device-not-found" });
        expect(message).toContain("tool=window_list: device-not-found");
        expect(message + saved).not.toMatch(/PRIVATE|password/);
    });
    it.each(["sandbox-id-invalid", "prerequisites-missing", "session-connect-failed", "response-rejected", "response-timeout"])("preserves closed helper stage %s and its original probe number", stage => {
        const readiness = { attempts: 3, lastProbe: "transport-exception", helperAttempt: 1,
            helper: { stage, requestAttempted: true, message: "PRIVATE-MESSAGE" } };
        const evidence = brokerToolFailureEvidence({ readiness });
        expect(evidence.readiness).toEqual({ attempts: 3, lastProbe: "transport-exception", helperAttempt: 1, helper: { stage, requestAttempted: true } });
        expect(formatBrokerToolFailure({ readiness }, "failed")).toContain(`"stage":"${stage}"`);
        expect(JSON.stringify(evidence)).not.toContain("PRIVATE");
    });
    it.each([0, -1, 4, 1.5, "1"])("rejects invalid retained helper attempt %s", helperAttempt => {
        const evidence = brokerToolFailureEvidence({ readiness: { attempts: 3, lastProbe: "provider-error", helperAttempt,
            helper: { stage: "PRIVATE-STAGE", requestOk: false } } });
        expect(evidence.readiness).toEqual({ attempts: 3, lastProbe: "provider-error", helper: { requestOk: false } });
    });
    it("shows bounded evidence directly in the short failure message", () => {
        expect(formatBrokerToolFailure({ error: "provider-command-failed", nativeHResult: -2147024809, nativeErrorCategory: 5 }, "failed"))
            .toContain("hresult=0x80070057: category=5");
        const message = formatBrokerToolFailure({ error: "device-start-not-ready", readiness: { attempts: 0, lastProbe: "not-attempted", private: "secret" } }, "failed");
        expect(message).toContain('readiness={"attempts":0,"lastProbe":"not-attempted"}');
        expect(message).not.toContain("secret");
        expect(message.length).toBeLessThanOrEqual(511);
    });
    it.each([false, true])("preserves native numeric diagnostics through envelope=%s", wrapped => {
        const failure = { error: "provider-command-failed", nativeHResult: -2147024809, nativeErrorCategory: 5,
            lifecycleFailure: { error: "provider-command-failed", operation: "Set-VMFirmware", nativeHResult: -2147024809, nativeErrorCategory: 5, message: "secret" } };
        const evidence = brokerToolFailureEvidence(wrapped ? { body: failure } : failure);
        expect(evidence).toMatchObject({ nativeHResult: -2147024809, nativeErrorCategory: 5,
            lifecycleFailure: { nativeHResult: -2147024809, nativeErrorCategory: 5 } });
        expect(JSON.stringify(evidence)).not.toContain("secret");
    });
    it.each(["secret", 1.5, 2147483648, -2147483649, null])("rejects invalid native HRESULT %s", nativeHResult => {
        expect(brokerToolFailureEvidence({ nativeHResult, nativeErrorCategory: 32 })).not.toHaveProperty("nativeHResult");
        expect(brokerToolFailureEvidence({ nativeHResult, nativeErrorCategory: 32 })).not.toHaveProperty("nativeErrorCategory");
    });
    it("saves only closed readiness evidence and omits raw helper fields", () => {
        const evidence = brokerToolFailureEvidence({ error: "device-start-not-ready", readiness: {
            attempts: 2, lastProbe: "provider-error", message: "secret", helper: {
                readyMarkerPresent: false, requestOk: false, guestStatus: 1, stdout: "secret", requestAttempted: "secret",
            },
        } });
        expect(evidence.readiness).toEqual({ attempts: 2, lastProbe: "provider-error", helper: { readyMarkerPresent: false, requestOk: false, guestStatus: 1 } });
        expect(JSON.stringify(evidence)).not.toContain("secret");
        expect(brokerToolFailureEvidence({ readiness: { attempts: 2, lastProbe: "private-token" } })).not.toHaveProperty("readiness");
    });
});
