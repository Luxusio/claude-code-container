import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { brokerToolFailureEvidence, formatBrokerToolFailure, parseToolPayload } from "./device-lab-mcp-client.ts";
import { repoRoot } from "./helpers.ts";
import { renderBrokerMacosBoot } from "@ccc/device-lab/device-lab/broker/broker-outcomes-codec.js";

const written: string[] = [];
afterEach(() => { for (const file of written.splice(0)) rmSync(file, { force: true }); });

function savedFailure(message: string | Record<string, unknown>, name?: string) {
    try {
        parseToolPayload({ isError: true, content: [{ type: "text", text: JSON.stringify(typeof message === "string" ? { ok: false, error: message } : message) }],
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
    it("preserves the actual Tart renderer's nested IP timeout without the instance or command", () => {
        const macosBoot = renderBrokerMacosBoot({ ok: false, reason: "timed-out", instance: "PRIVATE-INSTANCE", attempts: [] },
            { mode: "detached", provider: "tart", executable: "/PRIVATE-PATH/tart", args: ["run", "PRIVATE-INSTANCE"] });
        const value = { ok: false, error: "provider-command-failed", body: { error: "provider-command-failed", result: {
            execution: { mode: "detached", command: { provider: "tart", status: 0, stdout: "PRIVATE-OUTPUT", macosBoot } },
        } } };
        const { message, saved } = savedFailure(value, "start");
        expect(JSON.parse(saved).failure).toMatchObject({ execution: { status: 0 },
            macosBoot: { phase: "ip-readiness", ok: false, diagnosticCode: "macos-tart-ip-timeout", attemptCount: 0 } });
        expect(message).toContain("macos-tart-ip-timeout");
        expect(message + saved).not.toContain("PRIVATE");
    });

    it("retains a start process failure separately from IP readiness", () => {
        const { message, saved } = savedFailure({ ok: false, error: "provider-command-failed", body: {
            error: "provider-command-failed", result: { execution: { command: {
                status: 1, signal: null, stderr: "PRIVATE-STDERR", executable: "PRIVATE-PATH", args: ["PRIVATE-ARG"],
            } } },
        } }, "start");
        expect(JSON.parse(saved).failure.execution).toEqual({ status: 1, signal: null });
        expect(JSON.parse(saved).failure).not.toHaveProperty("macosBoot");
        expect(message).toContain('execution={"status":1,"signal":null}');
        expect(message + saved).not.toContain("PRIVATE");
    });

    it.each([
        { envelope: "body.result", wrapped: true, error: "macos-helper-scp-failed", provider: "scp",
            execution: { status: 255, signal: null, timedOut: false, errorCode: "ECONNREFUSED", diagnosticCode: "native-nonzero-exit" } },
        { envelope: "result", wrapped: false, error: "macos-helper-readiness-timeout", provider: "ssh",
            execution: { status: null, signal: "SIGTERM", timedOut: true, errorCode: "ETIMEDOUT", diagnosticCode: "native-timeout" } },
    ])("saves the distinct helper failure from $envelope alongside the successful Tart launch", ({ wrapped, error, provider, execution }) => {
        const result = {
            execution: { mode: "detached", command: { provider: "tart", status: 0, signal: null, stdout: "PRIVATE-LAUNCH-OUTPUT" } },
            helperPreparation: { ok: false, skipped: false, error,
                helper: { status: "failed", ssh: { host: "PRIVATE-HOST", user: "PRIVATE-USER", password: "PRIVATE-PASSWORD" },
                    remoteScriptPath: "/PRIVATE-GUEST-PATH", provisioning: { status: "failed", provider, updatedAt: "PRIVATE-TIMESTAMP", localScriptPath: "/PRIVATE-HOST-PATH" } },
                execution: { ...execution, command: "PRIVATE-COMMAND", args: ["PRIVATE-ARG"], stdout: "PRIVATE-STDOUT", stderr: "PRIVATE-STDERR" },
            },
        };
        const value = { ok: false, error: "provider-command-failed", ...(wrapped ? { body: { error: "provider-command-failed", result } } : { result }) };
        const { saved, message } = savedFailure(value, "start");
        const failure = JSON.parse(saved).failure;
        const helperPreparation = { error, provider, execution };
        expect(failure.execution).toEqual({ status: 0, signal: null });
        expect(failure.helperPreparation).toEqual(helperPreparation);
        const formatted = formatBrokerToolFailure(value, "failed", "start");
        expect(formatted).toContain('execution={"status":0,"signal":null}');
        expect(formatted).toContain(`helperPreparation=${JSON.stringify(helperPreparation)}`);
        expect(message).toContain(formatted);
        expect(formatted.length).toBeLessThanOrEqual(511);
        expect(saved + message).not.toMatch(/PRIVATE|password|remoteScriptPath|localScriptPath|updatedAt|stdout|stderr|args/);
    });

    it("retains a known helper error while omitting unknown provider and malformed execution fields", () => {
        const { saved, message } = savedFailure({ ok: false, error: "provider-command-failed", result: {
            helperPreparation: { error: "macos-helper-chmod-failed", provider: "ssh", helper: { provisioning: { provider: "PRIVATE-PROVIDER" } },
                execution: { status: -1, signal: "PRIVATE-SIGNAL", timedOut: "true", errorCode: "PRIVATE-CODE", diagnosticCode: "PRIVATE-DIAGNOSTIC", stderr: "PRIVATE-OUTPUT" } },
        } }, "start");
        expect(JSON.parse(saved).failure.helperPreparation).toEqual({ error: "macos-helper-chmod-failed" });
        expect(message).toContain('helperPreparation={"error":"macos-helper-chmod-failed"}');
        expect(saved + message).not.toMatch(/PRIVATE|"provider"|"execution"/);
    });

    it.each([false, true])("keeps the first closed helper failure distinct from the killed helper child, wrapped=%s", wrapped => {
        const firstFailure = { provider: "scp", execution: { status: 255, signal: null, timedOut: false }, connection: "refused" };
        const result = { execution: { command: { status: 0 } }, helperPreparation: { error: "macos-helper-readiness-timeout",
            execution: { status: null, signal: "SIGKILL", timedOut: true }, firstFailure: { ...firstFailure,
                stdout: "PRIVATE-STDOUT", stderr: "PRIVATE-STDERR", host: "PRIVATE-HOST", password: "PRIVATE-PASSWORD", args: ["PRIVATE-ARG"],
                execution: { ...firstFailure.execution, error: "PRIVATE-ERROR", command: "PRIVATE-COMMAND" } } } };
        const value = { ok: false, error: "macos-helper-readiness-timeout", ...(wrapped ? { body: { result } } : { result }) };
        const { saved, message } = savedFailure(value, "start");
        const preparation = JSON.parse(saved).failure.helperPreparation;
        expect(preparation).toEqual({ error: "macos-helper-readiness-timeout", execution: { status: null, signal: "SIGKILL", timedOut: true }, firstFailure });
        expect(JSON.parse(saved).failure.execution).toEqual({ status: 0 });
        expect(message).toContain('"firstFailure":{"provider":"scp"');
        expect(message).toContain('"connection":"refused"');
        expect(formatBrokerToolFailure(value, "failed", "start").length).toBeLessThanOrEqual(511);
        expect(saved + message).not.toMatch(/PRIVATE|"(?:password|stdout|stderr|command|args)"\s*:/);
    });

    it.each(["refused", "reset", "closed", "timeout", "unreachable", "authentication", "other"])("selects first helper connection category %s without raw diagnostics", connection => {
        const firstFailure = { provider: "ssh", execution: { status: null, signal: "SIGTERM", timedOut: true }, connection };
        const value = { result: { helperPreparation: { firstFailure: { ...firstFailure, stderr: "PRIVATE-DETAIL" } } } };
        expect(brokerToolFailureEvidence(value).helperPreparation).toEqual({ firstFailure });
        expect(formatBrokerToolFailure(value, "failed")).not.toContain("PRIVATE");
    });

    it.each([
        { provider: "PRIVATE-PROVIDER", connection: "PRIVATE-CONNECTION", execution: { status: -1, signal: "PRIVATE-SIGNAL", timedOut: "true" } },
        ["PRIVATE-FRAME"],
        null,
    ])("omits wholly unclassified first helper failure %j", firstFailure => {
        const value = { result: { helperPreparation: { error: "macos-helper-readiness-timeout", firstFailure } } };
        expect(brokerToolFailureEvidence(value).helperPreparation).toEqual({ error: "macos-helper-readiness-timeout" });
        expect(formatBrokerToolFailure(value, "failed")).not.toMatch(/PRIVATE|firstFailure/);
    });

    it.each([
        { provider: ["scp"] },
        { connection: ["refused"] },
        { provider: "PRIVATE-PROVIDER" },
        { connection: "PRIVATE-CONNECTION" },
        { execution: { status: "255", signal: null, timedOut: false } },
        { execution: { status: -1, signal: null, timedOut: false } },
        { execution: { status: Number.MAX_SAFE_INTEGER + 1, signal: null, timedOut: false } },
        { execution: { status: 255, signal: "PRIVATE-SIGNAL", timedOut: false } },
        { execution: { status: 255, signal: null, timedOut: "false" } },
        { execution: { status: 255, signal: null } },
    ])("rejects the entire first helper observation when a required field is invalid: %j", invalid => {
        const firstFailure = { provider: "scp", execution: { status: 255, signal: null, timedOut: false }, connection: "refused", ...invalid };
        const value = { result: { helperPreparation: { error: "macos-helper-readiness-timeout", firstFailure } } };
        expect(brokerToolFailureEvidence(value).helperPreparation).toEqual({ error: "macos-helper-readiness-timeout" });
        expect(formatBrokerToolFailure(value, "failed")).not.toMatch(/PRIVATE|firstFailure/);
    });

    it("does not report an earlier first failure as current helper success evidence", () => {
        const firstFailure = { provider: "scp", execution: { status: 255, signal: null, timedOut: false }, connection: "refused" };
        const value = { result: { helperPreparation: { ok: true, firstFailure } } };
        expect(brokerToolFailureEvidence(value)).not.toHaveProperty("helperPreparation");
        expect(formatBrokerToolFailure(value, "failed")).not.toContain("firstFailure");
    });

    it("ignores first helper failure outside the exact helper preparation envelope", () => {
        const firstFailure = { provider: "scp", execution: { status: 255, signal: null, timedOut: false }, connection: "refused" };
        for (const value of [{ firstFailure }, { result: { firstFailure } }, { result: { helperPreparation: [firstFailure] } },
            { result: { helperPreparation: { helper: { provisioning: { firstFailure } } } } }]) {
            expect(brokerToolFailureEvidence(value)).not.toHaveProperty("helperPreparation");
            expect(formatBrokerToolFailure(value, "failed")).not.toContain("firstFailure");
        }
    });

    it("keeps ordinary provider evidence unchanged when helper preparation is absent or entirely unknown", () => {
        const result = { execution: { command: { status: 7, signal: null } } };
        const baseline = { ok: false, error: "provider-command-failed", result };
        const value = { ...baseline, result: { ...result, helperPreparation: { error: "PRIVATE-ERROR",
            helper: { provisioning: { provider: "PRIVATE-PROVIDER" } }, execution: ["PRIVATE-EXECUTION"] } } };
        const { saved, message } = savedFailure(value, "start");
        expect(JSON.parse(saved).failure).toEqual({ tool: "start", error: "provider-command-failed", execution: { status: 7, signal: null } });
        expect(brokerToolFailureEvidence(value)).toEqual(brokerToolFailureEvidence(baseline));
        expect(formatBrokerToolFailure(value, "failed")).toBe(formatBrokerToolFailure(baseline, "failed"));
        expect(message + saved).not.toMatch(/PRIVATE|helperPreparation/);
    });

    it("ignores helper-shaped fields outside the two exact result envelopes and malformed preparation objects", () => {
        const helperPreparation = { error: "macos-helper-scp-failed", helper: { provisioning: { provider: "scp" } }, execution: { status: 255 } };
        for (const value of [
            { helperPreparation },
            { body: { helperPreparation } },
            { result: { execution: { helperPreparation } } },
            { body: { result: { helperPreparation: [helperPreparation] } } },
        ]) {
            const { saved, message } = savedFailure({ ok: false, error: "provider-command-failed", ...value }, "start");
            expect(JSON.parse(saved).failure).toEqual({ tool: "start", error: "provider-command-failed" });
            expect(saved + message).not.toContain("helperPreparation");
        }
    });

    it("saves only closed native process refusal observations", () => {
        const value = { ok: false, error: "broker-runtime-process-unverified", launch: { attempts: [{
            reason: "broker-reuse-process-unverified", processVerification: { source: "unverified-broker-port-process",
                observation: { stage: "command", reason: "native-command-failed", status: null, signal: "SIGTERM", code: "ETIMEDOUT",
                    command: "PRIVATE-COMMAND", stderr: "PRIVATE-STDERR", startToken: "PRIVATE-TOKEN" } },
        }] } };
        const { saved } = savedFailure(value);
        expect(JSON.parse(saved).failure.processObservation).toEqual({
            stage: "command", reason: "native-command-failed", status: null, signal: "SIGTERM", errorCode: "ETIMEDOUT",
        });
        expect(saved).not.toContain("PRIVATE");
        expect(brokerToolFailureEvidence({ attempts: [{ processVerification: { observation: {
            stage: "PRIVATE-STAGE", reason: "native-command-failed", status: 1,
        } } }] })).not.toHaveProperty("processObservation");
    });

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

    it.each([
        { stage: "broker-process", error: "broker-runtime-process-unverified", processObservation: {
            stage: "listener", reason: "native-command-failed", status: null, signal: "SIGTERM", errorCode: "ETIMEDOUT",
        } },
        { stage: "broker-transport", error: "broker-rpc-unavailable" },
        { stage: "provider", error: "provider-command-failed", execution: { status: 111, signal: null, errorCode: "EIO" } },
    ])("saves the closed readiness failure at stage $stage and its original attempt", failure => {
        const readiness = { attempts: 3, lastProbe: "transport-exception", failureAttempt: 1,
            failure: { ...failure, message: "PRIVATE-MESSAGE", stderr: "PRIVATE-OUTPUT", path: "PRIVATE-PATH", credentials: "PRIVATE-CREDENTIAL" } };
        const { message, saved } = savedFailure({ ok: false, error: "device-start-not-ready", readiness }, "start");
        expect(JSON.parse(saved).failure.readiness).toEqual({ attempts: 3, lastProbe: "transport-exception", failure, failureAttempt: 1 });
        expect(brokerToolFailureEvidence({ readiness }).readiness).toEqual({ attempts: 3, lastProbe: "transport-exception", failure, failureAttempt: 1 });
        expect(message).toContain(`"stage":"${failure.stage}"`);
        expect(message).toContain('"failureAttempt":1');
        expect(message.length).toBeLessThanOrEqual(511);
        expect(message + saved).not.toContain("PRIVATE");
        expect(JSON.stringify(JSON.parse(saved).failure)).not.toMatch(/credentials|stderr|path|message/);
    });

    it("independently reselects nested native readiness observations without output or identity fields", () => {
        const failure = { stage: "broker-process", error: "broker-runtime-process-unverified", processObservation: {
            stage: "command", reason: "native-command-failed", status: 1, signal: null, errorCode: "ENOENT",
            executable: "PRIVATE-COMMAND", stderr: "PRIVATE-STDERR", pid: 12345, startToken: "PRIVATE-TOKEN",
        }, execution: { status: 2, signal: "SIGTERM", errorCode: "EACCES", timedOut: true,
            diagnosticCode: "PRIVATE-DIAGNOSTIC", args: ["PRIVATE-ARG"], stdout: "PRIVATE-STDOUT" } };
        const evidence = brokerToolFailureEvidence({ readiness: { attempts: 2, lastProbe: "provider-error", failure, failureAttempt: 2 } });
        expect(evidence.readiness).toEqual({ attempts: 2, lastProbe: "provider-error", failureAttempt: 2, failure: {
            stage: "broker-process", error: "broker-runtime-process-unverified", processObservation: {
                stage: "command", reason: "native-command-failed", status: 1, signal: null, errorCode: "ENOENT",
            }, execution: { status: 2, signal: "SIGTERM", errorCode: "EACCES", timedOut: true },
        } });
        expect(JSON.stringify(evidence)).not.toMatch(/PRIVATE|pid|startToken|stdout|stderr|args/);
    });

    it.each(["native-timeout", "native-not-found", "native-permission-denied", "native-signal", "native-nonzero-exit", "native-unknown"])("independently preserves the closed readiness classification %s in the saved artifact", diagnosticCode => {
        const execution = { status: 1, signal: null, timedOut: false, diagnosticCode };
        const readiness = { attempts: 3, lastProbe: "provider-error", failureAttempt: 2,
            failure: { stage: "provider", error: "provider-command-failed", execution: {
                ...execution, command: "PRIVATE-COMMAND", executable: "/PRIVATE-PATH", args: ["PRIVATE-ARG"],
                stdout: "PRIVATE-STDOUT", stderr: "PRIVATE-STDERR", credentials: "PRIVATE-CREDENTIAL",
            } } };
        const { saved, message } = savedFailure({ ok: false, error: "device-start-not-ready", readiness }, "start");
        const selected = { attempts: 3, lastProbe: "provider-error", failureAttempt: 2,
            failure: { stage: "provider", error: "provider-command-failed", execution } };
        expect(JSON.parse(saved).failure.readiness).toEqual(selected);
        expect(brokerToolFailureEvidence({ readiness }).readiness).toEqual(selected);
        expect(message).toContain(`"diagnosticCode":"${diagnosticCode}"`);
        expect(message).toContain('"timedOut":false');
        expect(message.length).toBeLessThanOrEqual(511);
        expect(JSON.stringify(JSON.parse(saved).failure) + message).not.toContain("PRIVATE");
    });

    it("saves a native timeout alone without inventing a public error or an earlier probe number", () => {
        const readiness = { attempts: 192, lastProbe: "provider-error", failureAttempt: 191,
            failure: { stage: "provider", execution: { timedOut: true, diagnosticCode: "native-timeout" } } };
        const { saved, message } = savedFailure({ ok: false, error: "device-start-not-ready", readiness }, "start");
        expect(JSON.parse(saved).failure.readiness).toEqual(readiness);
        expect(message).toContain('"failureAttempt":191');
        expect(message).toContain('"timedOut":true');
    });

    it.each([
        { timedOut: false },
        { timedOut: "true", diagnosticCode: "PRIVATE-CODE" },
        { timedOut: false, diagnosticCode: "native-timeout" },
        { diagnosticCode: "native-nonzero-exit" },
        { status: 0, signal: null, timedOut: false, diagnosticCode: "PRIVATE-CODE" },
    ])("does not save a classified failure from false, malformed or diagnostic-only execution %j", execution => {
        const readiness = { attempts: 1, lastProbe: "provider-error", failureAttempt: 1, failure: { stage: "provider", execution } };
        const { saved, message } = savedFailure({ ok: false, error: "device-start-not-ready", readiness }, "start");
        expect(JSON.parse(saved).failure.readiness).toEqual({ attempts: 1, lastProbe: "provider-error" });
        expect(message).not.toMatch(/failureAttempt|PRIVATE|diagnosticCode|timedOut/);
    });

    it("does not extend process observations with the native execution timeout fields", () => {
        const processObservation = { stage: "listener", reason: "native-command-failed", status: null, signal: "SIGTERM", errorCode: "ETIMEDOUT" };
        const evidence = brokerToolFailureEvidence({ readiness: { attempts: 1, lastProbe: "provider-error", failureAttempt: 1,
            failure: { stage: "broker-process", processObservation: { ...processObservation, timedOut: true, diagnosticCode: "native-timeout" } } } });
        expect(evidence.readiness).toEqual({ attempts: 1, lastProbe: "provider-error", failureAttempt: 1,
            failure: { stage: "broker-process", processObservation } });
    });

    it("keeps selected native failure facts when no public error code was observed", () => {
        const failure = { stage: "provider", execution: { status: 1, signal: null, errorCode: "ENOENT" } };
        const readiness = { attempts: 1, lastProbe: "provider-error", failure, failureAttempt: 1 };
        expect(brokerToolFailureEvidence({ body: { readiness } }).readiness).toEqual(readiness);
        expect(formatBrokerToolFailure({ body: { readiness } }, "failed")).toContain('"errorCode":"ENOENT"');
    });

    it.each([
        { stage: "PRIVATE-STAGE", error: "PRIVATE-ERROR", execution: { status: "1" } },
        { stage: "provider", error: "private-provider-error", execution: {
            status: -1, signal: "PRIVATE-SIGNAL", errorCode: "PRIVATE-CODE", stdout: "PRIVATE-OUTPUT",
        } },
        { stage: "broker-process", processObservation: { stage: "PRIVATE-STAGE", reason: "PRIVATE-REASON", status: 1 } },
        { stage: "broker-transport" },
        ["PRIVATE-ARRAY"],
    ])("omits readiness failures without a classified code or valid native observation", failure => {
        const readiness = { attempts: 1, lastProbe: "provider-error", failure, failureAttempt: 1 };
        const evidence = brokerToolFailureEvidence({ readiness });
        expect(evidence.readiness).toEqual({ attempts: 1, lastProbe: "provider-error" });
        expect(formatBrokerToolFailure({ readiness }, "failed")).not.toMatch(/failureAttempt|PRIVATE|private-provider/);
    });

    it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"])("omits invalid readiness native status %s without discarding the known failure", status => {
        const readiness = { attempts: 1, lastProbe: "provider-error", failureAttempt: 1,
            failure: { stage: "provider", error: "provider-command-failed", execution: {
                status, signal: "PRIVATE-SIGNAL", errorCode: "PRIVATE-CODE", stderr: "PRIVATE-STDERR",
            } } };
        expect(brokerToolFailureEvidence({ readiness }).readiness).toEqual({ attempts: 1, lastProbe: "provider-error", failureAttempt: 1,
            failure: { stage: "provider", error: "provider-command-failed" } });
    });

    it.each([0, -1, 4, 1.5, "1"])("omits invalid readiness failure attempt %s while retaining the classified failure", failureAttempt => {
        const failure = { stage: "provider", error: "provider-command-failed" };
        const readiness = { attempts: 3, lastProbe: "transport-exception", failure, failureAttempt };
        expect(brokerToolFailureEvidence({ readiness }).readiness).toEqual({ attempts: 3, lastProbe: "transport-exception", failure });
    });

    it("retains helper and failure evidence with their independent original attempt numbers", () => {
        const readiness = { attempts: 3, lastProbe: "provider-error", helperAttempt: 1, helper: { requestOk: false },
            failureAttempt: 2, failure: { stage: "provider", error: "provider-command-failed" } };
        expect(brokerToolFailureEvidence({ readiness }).readiness).toEqual(readiness);
    });
});
