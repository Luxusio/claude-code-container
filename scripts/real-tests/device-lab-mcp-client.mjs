import { createHash } from "crypto";
import { readFileSync, statSync } from "fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "path";
import { repoRoot } from "./helpers.mjs";

const TOOL_CALLS_KEY = Symbol.for("ccc.deviceLabRealTests.toolCalls");
const TOOL_SESSIONS_KEY = Symbol.for("ccc.deviceLabRealTests.toolSessions");
let nextSessionId = 0;
const DEFAULT_REAL_MCP_TOOL_TIMEOUT_MS = 120000;
const LONG_REAL_MCP_TOOL_TIMEOUT_MS = 360000;
const MAX_REAL_MCP_TOOL_TIMEOUT_MS = 615000;

export function realMcpToolRequestTimeoutMs(name, args = {}) {
    const explicitRpcTimeoutMs = Number(args?.rpcTimeoutMs);
    if (Number.isFinite(explicitRpcTimeoutMs)) {
        return Math.min(MAX_REAL_MCP_TOOL_TIMEOUT_MS, Math.max(DEFAULT_REAL_MCP_TOOL_TIMEOUT_MS, explicitRpcTimeoutMs + 15000));
    }
    const helperTimeoutMs = Number(args?.helperTimeoutMs);
    if (Number.isFinite(helperTimeoutMs)) {
        return Math.min(MAX_REAL_MCP_TOOL_TIMEOUT_MS, Math.max(DEFAULT_REAL_MCP_TOOL_TIMEOUT_MS, helperTimeoutMs + 30000));
    }
    if (name === "device_create" && args?.createAvd === true) return LONG_REAL_MCP_TOOL_TIMEOUT_MS;
    if (name === "device_start" && args?.waitForBoot === true) {
        const bootTimeoutMs = Number(args?.bootTimeoutMs);
        return Number.isFinite(bootTimeoutMs)
            ? Math.min(MAX_REAL_MCP_TOOL_TIMEOUT_MS, Math.max(DEFAULT_REAL_MCP_TOOL_TIMEOUT_MS, bootTimeoutMs + 30000))
            : LONG_REAL_MCP_TOOL_TIMEOUT_MS;
    }
    if (name === "device_delete" && args?.deleteAvd === true) return LONG_REAL_MCP_TOOL_TIMEOUT_MS;
    if (name === "device_broker_appium" || name === "mobile_set_clipboard" || name === "mobile_get_clipboard") {
        return LONG_REAL_MCP_TOOL_TIMEOUT_MS;
    }
    if (typeof args?.backend === "string" && args.backend.startsWith("ios") && name.startsWith("mobile_")) {
        return LONG_REAL_MCP_TOOL_TIMEOUT_MS;
    }
    return DEFAULT_REAL_MCP_TOOL_TIMEOUT_MS;
}

function toolCalls() {
    if (!Array.isArray(globalThis[TOOL_CALLS_KEY])) globalThis[TOOL_CALLS_KEY] = [];
    return globalThis[TOOL_CALLS_KEY];
}

export function consumeDeviceLabMcpToolCalls() {
    const calls = [...toolCalls()];
    globalThis[TOOL_CALLS_KEY] = [];
    return calls;
}

function toolSessions() {
    if (!Array.isArray(globalThis[TOOL_SESSIONS_KEY])) globalThis[TOOL_SESSIONS_KEY] = [];
    return globalThis[TOOL_SESSIONS_KEY];
}

export function consumeDeviceLabMcpToolSessions() {
    const sessions = [...toolSessions()];
    globalThis[TOOL_SESSIONS_KEY] = [];
    return sessions;
}

function deviceLabMcpServerPath(options = {}) {
    return options.serverPath || process.env.CCC_REAL_DEVICE_LAB_MCP_SERVER || join(repoRoot, "device-lab-mcp/server.mjs");
}

function validBase64Payload(value) {
    const text = String(value || "");
    return text.length > 0 && text.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(text);
}

function validJsonContentValue(value) {
    return value !== null && typeof value === "object";
}

function jsonPayloadShape(value) {
    if (Array.isArray(value)) {
        return { kind: "array", itemCount: value.length };
    }
    if (value !== null && typeof value === "object") {
        return { kind: "object", keys: Object.keys(value).sort() };
    }
    return { kind: typeof value };
}

function contentText(content) {
    return content.map((item) => item?.text || "").join("\n");
}

function jsonContentPayload(content) {
    const jsonPayload = content
        .filter((item) => item?.type === "json")
        .map((item) => item?.value)
        .find(validJsonContentValue);
    if (jsonPayload) return jsonPayload;
    const text = contentText(content);
    if (!text.trim()) return null;
    try {
        const payload = JSON.parse(text);
        return validJsonContentValue(payload) ? payload : null;
    } catch {
        return null;
    }
}

function resultContent(result) {
    return Array.isArray(result?.content) ? result.content : [];
}

export function summarizeToolResultForProof(result) {
    const content = resultContent(result);
    const text = contentText(content);
    const jsonPayload = jsonContentPayload(content);
    const imagePayload = content.some((item) => (
        item?.type === "image"
        && typeof item.mimeType === "string"
        && item.mimeType.startsWith("image/")
        && validBase64Payload(item.data)
    ));
    const summary = {
        contentTypes: content.map((item) => String(item?.type || "")).filter(Boolean),
    };
    if (result?.isError === true) {
        summary.errorPayloadText = text.trim().length > 0;
        summary.errorDispatchMismatch = /Unknown tool:|Unexpected error:/.test(text);
        summary.errorPayloadJson = Boolean(jsonPayload);
        if (jsonPayload && typeof jsonPayload.error === "string" && jsonPayload.error) {
            summary.errorCode = jsonPayload.error;
        }
    } else {
        summary.okPayloadText = text.trim().length > 0;
        summary.okPayloadImage = imagePayload;
        summary.okPayloadJson = Boolean(jsonPayload);
        if (jsonPayload) summary.okPayloadShape = jsonPayloadShape(jsonPayload);
    }
    return summary;
}

function summarizeFlowStepPayload(step) {
    const content = Array.isArray(step?.content) ? step.content : [];
    const jsonItems = content.filter((item) => item?.type === "json");
    const imageItems = content.filter((item) => item?.type === "image");
    const summary = {
        tool: String(step?.tool || ""),
        isError: step?.isError === true,
        expectedError: false,
        contentTypes: content.map((item) => String(item?.type || "")).filter(Boolean),
    };
    if (summary.isError) {
        summary.errorPayloadJson = jsonItems.some((item) => validJsonContentValue(item?.value));
        const errorPayload = jsonItems.map((item) => item?.value).find((value) => validJsonContentValue(value) && typeof value.error === "string" && value.error);
        if (errorPayload) summary.errorCode = errorPayload.error;
    } else {
        const okJsonPayload = jsonItems.map((item) => item?.value).find(validJsonContentValue);
        summary.okPayloadJson = Boolean(okJsonPayload);
        if (okJsonPayload) summary.okPayloadShape = jsonPayloadShape(okJsonPayload);
        summary.okPayloadImage = imageItems.some((item) => (
            typeof item?.mimeType === "string"
            && item.mimeType.startsWith("image/")
            && Number(item?.bytes || 0) > 0
        ));
    }
    return summary;
}

function changedEnvKeys(env = {}) {
    return Object.keys(env)
        .filter((key) => env[key] !== process.env[key])
        .sort();
}

function fileFingerprint(path) {
    try {
        const bytes = readFileSync(path);
        const stat = statSync(path);
        return {
            exists: true,
            size: stat.size,
            sha256: createHash("sha256").update(bytes).digest("hex"),
        };
    } catch (error) {
        return {
            exists: false,
            size: 0,
            sha256: "",
            error: error?.message || String(error),
        };
    }
}

function toolSurfaceFingerprint(tools = []) {
    const surface = tools.map((tool) => ({
        name: tool.name,
        inputSchema: tool.inputSchema || {},
    }));
    return {
        toolCount: surface.length,
        sha256: createHash("sha256").update(JSON.stringify(surface)).digest("hex"),
    };
}

export async function withDeviceLabMcp(callback, options = {}) {
    const serverPath = deviceLabMcpServerPath(options);
    const sessionId = `mcp-session-${++nextSessionId}`;
    const sessionRecord = {
        id: sessionId,
        name: options.name || "ccc-real-device-lab-e2e",
        serverPath,
        serverSource: serverPath.includes("/dist/") || serverPath.includes("\\dist\\") ? "dist" : "source",
        serverFile: fileFingerprint(serverPath),
        node: process.execPath,
        envOverrides: changedEnvKeys(options.env),
    };
    toolSessions().push(sessionRecord);
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [serverPath],
        env: {
            ...process.env,
            ...(options.env || {}),
        },
    });
    const client = new Client(
        { name: options.name || "ccc-real-device-lab-e2e", version: "1.0.0" },
        { capabilities: {} },
    );
    await client.connect(transport);
    try {
        const listed = await client.listTools();
        sessionRecord.advertisedToolSurface = toolSurfaceFingerprint(Array.isArray(listed?.tools) ? listed.tools : []);
        return await callback({
            client,
            callTool: async (name, args = {}) => {
                const record = { name, arguments: args, outcome: "pending", mcpSessionId: sessionId };
                toolCalls().push(record);
                try {
                    const timeout = realMcpToolRequestTimeoutMs(name, args);
                    const result = await client.callTool(
                        { name, arguments: args },
                        undefined,
                        { timeout, maxTotalTimeout: timeout },
                    );
                    record.outcome = result?.isError === true ? "error-result" : "ok";
                    record.isError = result?.isError === true;
                    Object.assign(record, summarizeToolResultForProof(result));
                    if ((name === "device_run_flow" || name === "mobile_run_flow") && result?.isError !== true) {
                        try {
                            const payload = jsonContentPayload(resultContent(result)) || {};
                            if (Array.isArray(payload?.results)) {
                                record.flowSteps = payload.results.map(summarizeFlowStepPayload).filter((step) => step.tool);
                            }
                        } catch {
                            // Flow step tracing is proof metadata only; parsing failures should not affect the call.
                        }
                    }
                    if (result && typeof result === "object") {
                        try {
                            Object.defineProperty(result, "__cccToolCallRecord", {
                                value: record,
                                enumerable: false,
                                configurable: true,
                            });
                        } catch {
                            // Outcome tracing is best-effort; the call result still drives the test.
                        }
                    }
                    return result;
                } catch (error) {
                    record.outcome = "thrown";
                    record.error = error?.message || String(error);
                    throw error;
                }
            },
        });
    } finally {
        await client.close();
    }
}

export function parseToolPayload(result) {
    const text = result?.content?.[0]?.text || "{}";
    if (result?.isError) throw new Error(text);
    const payload = jsonContentPayload(resultContent(result));
    if (payload) return payload;
    return JSON.parse(text);
}

export function parseToolResult(result, options = {}) {
    if (options.expectedError === true && result?.isError === true && result.__cccToolCallRecord) {
        result.__cccToolCallRecord.expectedError = true;
    }
    const payload = jsonContentPayload(resultContent(result));
    if (payload) return payload;
    return JSON.parse(result?.content?.[0]?.text || "{}");
}

export function markExpectedToolError(result) {
    if (result?.isError === true && result.__cccToolCallRecord) {
        result.__cccToolCallRecord.expectedError = true;
    }
    return result;
}

export function markExpectedFlowStepErrors(result, tools = []) {
    const expectedTools = new Set(tools.map(String));
    const record = result?.__cccToolCallRecord;
    if (!record || !Array.isArray(record.flowSteps)) return result;
    for (const step of record.flowSteps) {
        if (step?.isError === true && (expectedTools.size === 0 || expectedTools.has(step.tool))) {
            step.expectedError = true;
        }
    }
    return result;
}
