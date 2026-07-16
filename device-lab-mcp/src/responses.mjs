export const MCP_ERROR_TEXT_LIMIT_BYTES = 64 * 1024;
const MCP_ERROR_SUMMARY_STRING_LIMIT_BYTES = 4096;
const ERROR_SUMMARY_KEYS = ["ok", "error", "code", "ownerId", "method", "backend", "deviceId", "tool", "routedBy", "status"];

function utf8Bytes(value) {
    return Buffer.byteLength(value, "utf8");
}

export function truncateDiagnosticText(value, limitBytes = MCP_ERROR_TEXT_LIMIT_BYTES) {
    const text = String(value ?? "");
    const requestedLimit = Number(limitBytes);
    const boundedLimit = Number.isFinite(requestedLimit) ? Math.max(0, Math.trunc(requestedLimit)) : MCP_ERROR_TEXT_LIMIT_BYTES;
    const originalBytes = utf8Bytes(text);
    if (originalBytes <= boundedLimit) return text;
    const suffix = `\n...[diagnostic truncated: ${originalBytes} bytes, limit ${boundedLimit} bytes]`;
    if (utf8Bytes(suffix) >= boundedLimit) return Buffer.from(suffix, "utf8").subarray(0, boundedLimit).toString("utf8");
    const prefixBudget = boundedLimit - utf8Bytes(suffix);
    let prefix = Buffer.from(text, "utf8").subarray(0, prefixBudget).toString("utf8");
    while (prefix && utf8Bytes(prefix) > prefixBudget) prefix = prefix.slice(0, -1);
    return `${prefix}${suffix}`;
}

function isFailureDiagnostic(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        && (value.ok === false || typeof value.error === "string");
}

function oversizedDiagnosticSummary(value, originalBytes) {
    const summary = {};
    for (const key of ERROR_SUMMARY_KEYS) {
        const item = value[key];
        if (item === null || typeof item === "boolean" || typeof item === "number") summary[key] = item;
        else if (typeof item === "string") summary[key] = truncateDiagnosticText(item, MCP_ERROR_SUMMARY_STRING_LIMIT_BYTES);
    }
    if (summary.ok === undefined) summary.ok = false;
    if (typeof summary.error !== "string") summary.error = "diagnostic-response-too-large";
    return {
        ...summary,
        diagnosticTruncated: true,
        originalBytes,
        maxBytes: MCP_ERROR_TEXT_LIMIT_BYTES,
    };
}

export function textResult(ok, text) {
    return { content: [{ type: "text", text: ok ? text : truncateDiagnosticText(text) }], isError: !ok };
}

export function jsonResult(value) {
    let text = JSON.stringify(value, null, 2);
    if (isFailureDiagnostic(value)) {
        const originalBytes = utf8Bytes(text);
        if (originalBytes > MCP_ERROR_TEXT_LIMIT_BYTES) text = JSON.stringify(oversizedDiagnosticSummary(value, originalBytes), null, 2);
    }
    return textResult(true, text);
}

export function fail(result) {
    const detail = result.stderr
        || result.stdout
        || result.error?.message
        || (result.signal ? `signal ${result.signal}` : "")
        || `exit ${result.status}`;
    return textResult(false, `Error: ${detail}`);
}
