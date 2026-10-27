import { waitForStartReadiness } from "@ccc/device-lab/providers/application/start-readiness.mjs";
import { jsonResult } from "@ccc/device-lab/providers/responses.mjs";
import { constants as osConstants } from "node:os";

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const FAILURE_ERRORS = {
    "broker-process": ["broker-runtime-process-unverified", "broker-runtime-generation-changed", "broker-incompatible-process-still-running", "broker-launch-failed"],
    "broker-transport": ["broker-rpc-unavailable", "broker-rpc-failed", "broker-owner-resolve-unavailable", "broker-owner-resolve-failed", "broker-owner-resolve-readiness-timeout", "broker-owner-auth-unavailable", "broker-launch-owner-resolve-timeout", "broker-launch-health-timeout", "host-broker-incompatible", "broker-response-too-large", "invalid-broker-json", "invalid-broker-content-length", "broker-redirect-disallowed", "broker-observation-budget-exhausted-before-rpc"],
    provider: ["provider-command-failed", "device-lab-backend-tool-failed", "device-lab-backend-tool-invalid-json", "device-lab-backend-module-missing", "windows-sandbox-helper-timeout", "windows-sandbox-helper-failed", "windows-sandbox-helper-response-rejected", "owner-device-not-found", "device-not-found", "device-backend-not-found", "owner-device-state-conflict", "device-tool-unsupported", "broker-device-tool-backend-not-supported", "broker-device-tool-not-supported"],
};
const TRANSPORT_CODES = ["timeout", "connection-reset", "connection-refused", "broken-pipe", "response-aborted", "transport-error"];

function nativeExecution(value) {
    if (!object(value)) return undefined;
    const evidence = {};
    if (value.status === null || (Number.isSafeInteger(value.status) && value.status >= 0)) evidence.status = value.status;
    if (value.signal === null || (typeof value.signal === "string" && Object.hasOwn(osConstants.signals, value.signal))) evidence.signal = value.signal;
    if (typeof value.errorCode === "string" && Object.hasOwn(osConstants.errno, value.errorCode)) evidence.errorCode = value.errorCode;
    return Object.keys(evidence).length ? evidence : undefined;
}

function processObservation(value) {
    if (!object(value)
        || !["listener", "command", "start-token", "identity"].includes(value.stage)
        || !["native-command-failed", "native-output-unavailable", "budget-exhausted", "invalid-runtime", "listener-pid-mismatch", "status-identity-unverified", "runtime-continuity-unverified", "command-line-unverified"].includes(value.reason)) return undefined;
    return { stage: value.stage, reason: value.reason,
        ...nativeExecution({ status: value.status, signal: value.signal, errorCode: value.code }),
    };
}

function failedExecution(value) {
    return value && ((typeof value.status === "number" && value.status !== 0) || value.signal || value.errorCode);
}

/** @returns {import('@ccc/device-lab/providers/domain/readiness.mjs').ReadinessFailure|undefined} */
function failureEvidence(result) {
    const values = observations(result, true);
    const nativeObservation = values.map(value => processObservation(value.processVerification?.observation)).findLast(Boolean);
    const executionFor = value => {
        // A broker wrapper's status is HTTP; native child status belongs to its body.
        const envelope = object(value.body) && value.body.error === value.error ? value.body : value;
        return nativeExecution(envelope.execution?.command) ?? nativeExecution(envelope.execution)
            ?? nativeExecution(envelope.result?.execution?.command) ?? nativeExecution(envelope.result?.execution)
            ?? nativeExecution(envelope.error === "device-lab-backend-tool-failed" ? envelope : undefined);
    };
    // Prefer the current envelope's known error over preceding setup attempts.
    for (const value of values) for (const stage of /** @type {const} */ (["broker-process", "broker-transport", "provider"])) {
        if (!FAILURE_ERRORS[stage].includes(value.error)) continue;
        const execution = executionFor(value);
        return { stage, error: value.error,
            ...(stage === "broker-process" && nativeObservation ? { processObservation: nativeObservation } : {}),
            ...(execution ? { execution } : {}),
        };
    }
    if (nativeObservation) return { stage: "broker-process", processObservation: nativeObservation };
    const transportCode = values.map(value => value.transportCode).findLast(value => TRANSPORT_CODES.includes(value));
    if (transportCode) return { stage: "broker-transport", error: transportCode };
    const execution = values.map(executionFor).findLast(failedExecution);
    return execution ? { stage: "provider", execution } : undefined;
}

function helperEvidence(value) {
    if (!object(value)) return undefined;
    const evidence = {};
    if (["sandbox-id-invalid", "prerequisites-missing", "session-connect-failed", "response-rejected", "response-timeout"].includes(value.stage)) evidence.stage = value.stage;
    if (["login-unavailable", "timeout", "command-failed"].includes(value.bootstrapFailure)) evidence.bootstrapFailure = value.bootstrapFailure;
    for (const key of ["bootstrapDeadlineExhausted", "readyMarkerPresent", "bootstrapAttempted", "bootstrapOk", "requestAttempted", "requestOk", "responseParseFailed"]) {
        if (typeof value[key] === "boolean") evidence[key] = value[key];
    }
    if (Number.isInteger(value.guestStatus) && value.guestStatus >= -2147483648 && value.guestStatus <= 2147483647) evidence.guestStatus = value.guestStatus;
    if (object(value.logEvidence)) {
        const logs = {};
        for (const key of ["bootstrapStarted", "bootstrapReady", "helperHeartbeat"]) {
            if (typeof value.logEvidence[key] === "boolean") logs[key] = value.logEvidence[key];
        }
        for (const key of ["bootstrapStderr", "helperStderr"]) {
            if (["absent", "empty", "access-denied", "path-not-found", "script-policy", "parse-error", "other-error", "unreadable", "oversized"].includes(value.logEvidence[key])) logs[key] = value.logEvidence[key];
        }
        if (Object.keys(logs).length) evidence.logEvidence = logs;
    }
    return Object.keys(evidence).length ? evidence : undefined;
}

// Traverse only protocol envelopes, never arbitrary guest output.
function observations(result, diagnostics = false) {
    const values = [];
    const visit = (value, depth = 0) => {
        if (!object(value) || depth > 8 || (diagnostics && values.length >= 128)) return;
        values.push(value);
        for (const key of ["result", "body", "response", "selected", "device", "boot", "lastBootCheck"]) visit(value[key], depth + 1);
        if (diagnostics) {
            for (const key of ["structuredContent", "launch", "ownerResolve", "mcpResult"]) visit(value[key], depth + 1);
            if (Array.isArray(value.attempts)) for (const attempt of value.attempts.slice(-16)) visit(attempt, depth + 1);
        }
        if (Array.isArray(value.content)) for (const item of diagnostics ? value.content.slice(0, 16) : value.content) {
            if (item?.type !== "text" || (diagnostics && (typeof item.text !== "string" || item.text.length > 65536))) continue;
            try { visit(JSON.parse(item.text), depth + 1); } catch { /* plain acknowledgments */ }
        }
    };
    visit(result);
    return values;
}

export function startBootTimeoutMs(args, backend = args?.backend) {
    return Number.isFinite(args?.bootTimeoutMs)
        ? Math.min(600000, Math.max(1000, args.bootTimeoutMs))
        : backend === "macos-vm" ? 300000 : 60000;
}

export async function finishStartReadiness(result, args, startedAt, invoke, {
    now = Date.now,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
    if (args.waitForBoot === false) return result;
    const values = observations(result);
    if (values.some(value => value.isError === true || value.ok === false || value.error)) {
        return result.isError === true ? result : { ...result, isError: true };
    }
    const device = values.find(value => (value.id === args.deviceId || value.deviceId === args.deviceId) && typeof value.backend === "string");
    const backend = device?.backend ?? args.backend;
    const failure = (detail, readiness) => jsonResult({ ok: false, error: "device-start-not-ready", deviceId: args.deviceId, detail, ...(readiness ? { readiness } : {}) });
    if (!backend) return failure("missing-start-backend");
    if (values.some(value => (value.bootReady === false && value.lastBootCheck?.skipped !== true)
        || (value.ready === false && value.skipped !== true))) {
        return failure("boot-readiness-failed");
    }
    if (!["macos-vm", "windows-sandbox"].includes(backend)) return result;
    const outcome = await waitForStartReadiness(startedAt + startBootTimeoutMs(args, backend), {
        now,
        sleep,
        probe: async ({ timeoutMs, remainingMs }) => {
            const probe = await invoke("device_cursor_position", {
                ...Object.fromEntries(["broker", "viaBroker", "implicitBroker", "host", "port", "hostCandidates", "autolaunch", "brokerProbeTimeoutMs"]
                    .filter(key => Object.hasOwn(args, key)).map(key => [key, args[key]])),
                deviceId: args.deviceId,
                backend,
                ...(args.incarnationId ? { incarnationId: args.incarnationId } : {}),
                helperTimeoutMs: timeoutMs,
                rpcTimeoutMs: remainingMs,
            });
            const observed = observations(probe);
            return {
                failed: observed.some(value => value.isError === true || value.ok === false || value.error),
                ready: observed.some(value => object(value.cursor) && Number.isFinite(value.cursor.x) && Number.isFinite(value.cursor.y)),
                helper: observed.map(value => helperEvidence(value.helperDiagnostic)).find(Boolean),
                failure: failureEvidence(probe),
            };
        },
    });
    return outcome.kind === "ready" ? result : failure("control-transport-timeout", outcome.readiness);
}
