/** Native transport result; shared application Result remains opaque.
 * @typedef {{content:{type:string,text?:string,data?:unknown,mimeType?:string}[],isError?:boolean}} IosAccessNativeResult
 */
export const MCP_ERROR_TEXT_LIMIT_BYTES = 64 * 1024;
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
    if (utf8Bytes(suffix) >= boundedLimit) {
        let excerpt = Buffer.from(suffix, "utf8").subarray(0, boundedLimit).toString("utf8");
        while (utf8Bytes(excerpt) > boundedLimit) excerpt = excerpt.slice(0, -1);
        return excerpt;
    }
    const prefixBudget = boundedLimit - utf8Bytes(suffix);
    let prefix = Buffer.from(text, "utf8").subarray(0, prefixBudget).toString("utf8");
    while (prefix && utf8Bytes(prefix) > prefixBudget) prefix = prefix.slice(0, -1);
    return `${prefix}${suffix}`;
}

function isFailureDiagnostic(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        && (value.ok === false || value.isError === true || Boolean(value.error));
}

const RECOVERY_KEYS = ["cause", "reason", "remedy", "remedies", "recovery", "cleanup", "containment", "scrubContainmentFailed", "detail", "result", "response", "body", "broker"];

// Bound the structure before serializing: escaping can multiply a string's byte
// length, so a raw UTF-8 limit alone does not bound a JSON response.
function diagnosticValue(value, stringLimit, nodeLimit, depth = 0, budget = { remaining: nodeLimit }) {
    if (typeof value === "string") return truncateDiagnosticText(value, stringLimit);
    if (value === null || typeof value !== "object") return value;
    if (depth >= 8 || budget.remaining-- <= 0) return { diagnosticTruncated: true };
    if (Array.isArray(value)) {
        const entries = value.slice(0, Math.min(nodeLimit, 50)).map(item => diagnosticValue(item, stringLimit, nodeLimit, depth + 1, budget));
        if (entries.length < value.length) entries.push({ diagnosticTruncated: true, omittedCount: value.length - entries.length });
        return entries;
    }
    const keys = [...new Set([...ERROR_SUMMARY_KEYS, ...RECOVERY_KEYS, ...Object.keys(value)])].filter(key => Object.hasOwn(value, key));
    const result = {};
    for (const key of keys.slice(0, nodeLimit)) {
        result[truncateDiagnosticText(key, Math.min(128, stringLimit))] = diagnosticValue(value[key], stringLimit, nodeLimit, depth + 1, budget);
    }
    if (keys.length > nodeLimit) result.diagnosticTruncated = true;
    return result;
}

function oversizedDiagnosticSummary(value, originalBytes) {
    for (const [stringLimit, nodeLimit] of [[4096, 32], [1024, 24], [256, 16], [64, 8], [16, 4], [16, 1]]) {
        const summary = {};
        // Each recovery field gets its own budget; a giant cause cannot evict
        // the later remedy, cleanup or containment result.
        for (const key of [...ERROR_SUMMARY_KEYS, ...RECOVERY_KEYS]) {
            if (Object.hasOwn(value, key)) summary[key] = diagnosticValue(value[key], stringLimit, nodeLimit);
        }
        if (summary.ok === undefined) summary.ok = false;
        if (typeof summary.error !== "string") summary.error = "diagnostic-response-too-large";
        Object.assign(summary, { diagnosticTruncated: true, originalBytes, maxBytes: MCP_ERROR_TEXT_LIMIT_BYTES });
        if (utf8Bytes(JSON.stringify(summary, null, 2)) <= MCP_ERROR_TEXT_LIMIT_BYTES) return summary;
    }
}

export function textResult(ok, text) {
    return { content: [{ type: "text", text: ok ? text : truncateDiagnosticText(text) }], isError: !ok };
}

function serializedJsonResult(value, text) {
    // JSON has already been bounded structurally. Text truncation here could
    // corrupt its syntax; nested command/RPC data does not set the outer flag.
    return { content: [{ type: "text", text }], isError: value?.ok === false };
}

export function jsonResult(value) {
    let text = JSON.stringify(value, null, 2);
    if (isFailureDiagnostic(value)) {
        const originalBytes = utf8Bytes(text);
        if (originalBytes > MCP_ERROR_TEXT_LIMIT_BYTES) text = JSON.stringify(oversizedDiagnosticSummary(value, originalBytes), null, 2);
    }
    return serializedJsonResult(value, text);
}

// Only flow envelopes use this bound: preserve step outcomes before spending
// the remaining bytes on diagnostics. Standalone opaque tool results are unchanged.
export function flowJsonResult(value, { detail = false } = {}) {
    let serialize = (item) => JSON.stringify(item, null, detail ? 2 : undefined);
    let text = serialize(value);
    if (value.ok !== false || utf8Bytes(text) <= MCP_ERROR_TEXT_LIMIT_BYTES) return serializedJsonResult(value, text);
    const originalBytes = utf8Bytes(text);
    serialize = (item) => JSON.stringify(item);
    const marker = (item) => ({ diagnosticTruncated: true, originalBytes: utf8Bytes(JSON.stringify(item)) });
    const summary = {
        ...value,
        diagnosticTruncated: true,
        originalBytes,
        maxBytes: MCP_ERROR_TEXT_LIMIT_BYTES,
        results: value.results.map((step) => ({
            ...step,
            ...(Array.isArray(step.content) ? { content: step.content.map((item) =>
                !step.isError && (item.type === "json" || item.type === "text")
                    ? { type: item.type, ...marker(item), omitted: true }
                    : item) } : {}),
        })),
    };
    text = serialize(summary);
    if (utf8Bytes(text) <= MCP_ERROR_TEXT_LIMIT_BYTES) return serializedJsonResult(value, text);

    // Put actionable evidence ahead of bulky observations if a pathological
    // diagnostic must ultimately become a bounded JSON excerpt.
    const evidenceKeys = ["ok", "code", "error", "cause", "reason", "remedy", "remedies", "recovery", "cleanup", "containment", "scrubContainmentFailed", "detail", "result", "body"];
    const diagnostic = (item, limit) => JSON.stringify(item, (_key, entry) => {
        if (typeof entry === "string") return truncateDiagnosticText(entry, limit);
        if (entry && typeof entry === "object" && !Array.isArray(entry)) {
            const keys = Object.keys(entry);
            return Object.fromEntries([
                ...evidenceKeys.filter((key) => keys.includes(key)),
                ...keys.filter((key) => !evidenceKeys.includes(key)),
            ].map((key) => [key, entry[key]]));
        }
        return entry;
    });
    // Budget the actual serialized representation, including JSON escaping and
    // indentation. Binary search also handles multibyte labels and diagnostics.
    const excerpt = (input, budget) => {
        let low = 0;
        let high = utf8Bytes(input);
        while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            if (utf8Bytes(serialize(truncateDiagnosticText(input, middle))) <= budget) low = middle;
            else high = middle - 1;
        }
        return truncateDiagnosticText(input, low);
    };
    // Each step gets a fair budget, so 50 failures cannot evict the last cause.
    const envelopeBytes = utf8Bytes(serialize({ ...summary, results: [] }));
    const stepBudget = Math.floor((MCP_ERROR_TEXT_LIMIT_BYTES - envelopeBytes - 512) / summary.results.length);
    summary.results = summary.results.map((step) => {
        const bounded = { ...step };
        for (const key of ["label", "tool", "error"]) {
            if (typeof bounded[key] !== "string") continue;
            const shortened = excerpt(bounded[key], Math.min(512, Math.floor(stepBudget / 8)));
            if (shortened !== bounded[key]) {
                bounded[`${key}Truncated`] = { originalBytes: utf8Bytes(bounded[key]) };
                bounded[key] = shortened;
            }
        }
        if (!Array.isArray(step.content)) return bounded;
        const contentBudget = stepBudget - utf8Bytes(serialize({ ...bounded, content: [] })) - 32;
        const itemBudget = Math.floor(contentBudget / step.content.length) - 16;
        bounded.content = step.content.map((item) => {
            if (utf8Bytes(serialize(item)) <= itemBudget) return item;
            const metadata = { type: item.type, ...marker(item) };
            if (item.omitted) return item;
            // Preserve structured cleanup/cause objects when string truncation
            // suffices; mark the containing content with its original byte size.
            for (const limit of [1024, 256, 64]) {
                const candidate = { ...JSON.parse(diagnostic(item, limit)), ...metadata };
                if (utf8Bytes(serialize(candidate)) <= itemBudget) return candidate;
            }
            const candidate = { ...metadata, diagnostic: "" };
            candidate.diagnostic = excerpt(diagnostic(item, 64), Math.max(2, itemBudget - utf8Bytes(serialize(candidate))));
            return candidate;
        });
        // Many content blocks can exceed even the marker budget. Keep the step
        // identity/outcome and explicitly bound their combined diagnostic.
        if (utf8Bytes(serialize(bounded)) > stepBudget) {
            const item = { type: "text", ...marker(step.content), contentCount: step.content.length, diagnostic: "" };
            bounded.content = [item];
            item.diagnostic = excerpt(diagnostic(step.content, 64), Math.max(2, stepBudget - utf8Bytes(serialize(bounded))));
        }
        return bounded;
    });
    return serializedJsonResult(value, serialize(summary));
}

export function fail(result) {
    const detail = result.stderr
        || result.stdout
        || result.error?.message
        || (result.signal ? `signal ${result.signal}` : "")
        || `exit ${result.status}`;
    return textResult(false, `Error: ${detail}`);
}
