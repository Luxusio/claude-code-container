import { createHash } from "crypto";
import { readFileSync, statSync } from "fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "path";
import { DEVICE_LAB_OUTPUT_CONTRACTS, hasDeviceLabOutputContract, validateDeviceLabToolOutput } from "../../device-lab-mcp/src/contracts/tool-contracts.mjs";
import type { DeviceLabToolOutputMap, DeviceRecord } from "../../device-lab-mcp/src/contracts/tool-contracts.mjs";
import { repoRoot } from "./helpers.ts";

const TOOL_CALLS_KEY = Symbol.for("ccc.deviceLabRealTests.toolCalls");
const TOOL_SESSIONS_KEY = Symbol.for("ccc.deviceLabRealTests.toolSessions");
let nextSessionId = 0;
const DEFAULT_REAL_MCP_TOOL_TIMEOUT_MS = 120000;
const LONG_REAL_MCP_TOOL_TIMEOUT_MS = 360000;
const HYPER_V_MAX_SERVER_RPC_TIMEOUT_MS = 21615000;
const MAX_REAL_MCP_TOOL_TIMEOUT_MS = HYPER_V_MAX_SERVER_RPC_TIMEOUT_MS;
const HYPER_V_MAX_CLIENT_TIMEOUT_MS = HYPER_V_MAX_SERVER_RPC_TIMEOUT_MS + 30000;
const HYPER_V_HOST_LOCK_WAIT_MS = 600000;
const HYPER_V_PROVIDER_LIFECYCLE_TIMEOUT_MS = 120000;
const HYPER_V_LIFECYCLE_RPC_BUFFER_MS = 15000;
const HYPER_V_MAX_BOOT_TIMEOUT_MS = 1200000;
const REAL_MCP_CLIENT_RPC_BUFFER_MS = 30000;
const HYPER_V_LIFECYCLE_TOOLS = new Set([
    "device_create",
    "device_status",
    "device_start",
    "device_stop",
    "device_reboot",
    "device_delete",
]);

export function realMcpToolRequestTimeoutMs(name: string, args: Record<string, any> = {}) {
    const hyperVBackend = args?.backend === "windows-vm" || args?.backend === "linux-vm";
    if (hyperVBackend && name === "device_create") {
        return HYPER_V_MAX_SERVER_RPC_TIMEOUT_MS + REAL_MCP_CLIENT_RPC_BUFFER_MS;
    }
    if (hyperVBackend && (name === "device_start" || name === "device_reboot")) {
        const bootTimeoutMs = args?.waitForBoot === false
            ? 0
            : Number.isFinite(args?.bootTimeoutMs)
                ? Math.min(HYPER_V_MAX_BOOT_TIMEOUT_MS, Math.max(1000, Number(args.bootTimeoutMs)))
                : 5 * 60 * 1000;
        const automaticRpcTimeoutMs = HYPER_V_HOST_LOCK_WAIT_MS
            + HYPER_V_PROVIDER_LIFECYCLE_TIMEOUT_MS
            + bootTimeoutMs
            + HYPER_V_LIFECYCLE_RPC_BUFFER_MS;
        return Math.min(HYPER_V_MAX_CLIENT_TIMEOUT_MS, automaticRpcTimeoutMs + REAL_MCP_CLIENT_RPC_BUFFER_MS);
    }
    if (hyperVBackend && HYPER_V_LIFECYCLE_TOOLS.has(name)) {
        return HYPER_V_HOST_LOCK_WAIT_MS
            + HYPER_V_PROVIDER_LIFECYCLE_TIMEOUT_MS
            + HYPER_V_LIFECYCLE_RPC_BUFFER_MS
            + REAL_MCP_CLIENT_RPC_BUFFER_MS;
    }
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

function deviceLabMcpServerPath(options: any = {}) {
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
    const summary: Record<string, any> = {
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
    const summary: Record<string, any> = {
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

export async function withDeviceLabMcp(callback, options: any = {}) {
    const serverPath = deviceLabMcpServerPath(options);
    const sessionId = `mcp-session-${++nextSessionId}`;
    const sessionRecord: Record<string, any> = {
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
        const callTool = async (name: string, args: Record<string, any> = {}) => {
            const record: Record<string, any> = { name, arguments: args, outcome: "pending", mcpSessionId: sessionId };
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
        };
        return await callback({
            client,
            callTool,
            callContractTool: async (name, args = {}) => {
                if (!hasDeviceLabOutputContract(name)) throw new Error(`No output contract registered for ${name}`);
                return validateDeviceLabToolOutput(name, parseToolPayload(await callTool(name, args)));
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

export function formatBrokerToolFailure(value: any, fallback: string) {
    const body = value?.body && typeof value.body === "object" && !Array.isArray(value.body)
        ? value.body
        : null;
    const execution = value?.provisioning && typeof value.provisioning === "object"
        ? value.provisioning
        : body?.provisioning && typeof body.provisioning === "object"
            ? body.provisioning
            : null;
    const diagnostic = execution
        ? JSON.stringify({
            status: execution.status,
            signal: execution.signal,
            error: execution.error,
            diagnosticCode: execution.diagnosticCode,
            stdout: String(execution.stdout || "").slice(-1024),
            stderr: String(execution.stderr || "").slice(-2048),
        })
        : "";
    const attempts = Array.isArray(value?.attempts)
        ? value.attempts
        : Array.isArray(value?.launch?.attempts)
            ? value.launch.attempts
            : [];
    const lastAttempt = attempts.length > 0 && attempts[attempts.length - 1]
        && typeof attempts[attempts.length - 1] === "object"
        ? attempts[attempts.length - 1]
        : null;
    const transportError = String(lastAttempt?.error || "").toLowerCase();
    const transportErrorCode = transportError.includes("timeout")
        ? "timeout"
        : transportError.includes("econnrefused") || transportError.includes("connection refused")
            ? "connection-refused"
            : transportError.includes("abort")
                ? "aborted"
                : transportError.includes("fetch")
                    ? "fetch-failed"
                    : transportError
                        ? "transport-error"
                        : undefined;
    const transportDiagnostic = lastAttempt
        ? JSON.stringify({
            port: Number.isFinite(lastAttempt.port) ? lastAttempt.port : undefined,
            status: Number.isFinite(lastAttempt.status) ? lastAttempt.status : undefined,
            error: transportErrorCode,
            durationMs: Number.isFinite(lastAttempt.durationMs) ? lastAttempt.durationMs : undefined,
            timeoutMs: Number.isFinite(lastAttempt.timeoutMs) ? lastAttempt.timeoutMs : undefined,
        })
        : "";
    const boot = body?.result?.boot && typeof body.result.boot === "object" && !Array.isArray(body.result.boot)
        ? body.result.boot
        : value?.result?.boot && typeof value.result.boot === "object" && !Array.isArray(value.result.boot)
            ? value.result.boot
            : null;
    const bootObservation = boot?.diagnostic && typeof boot.diagnostic === "object" && !Array.isArray(boot.diagnostic)
        ? boot.diagnostic
        : null;
    const bootDiagnostic = boot
        ? JSON.stringify({
            provider: typeof boot.provider === "string" ? boot.provider : undefined,
            error: typeof boot.error === "string" ? boot.error : undefined,
            state: bootObservation && typeof bootObservation.state === "string" ? bootObservation.state.slice(0, 64) : undefined,
            uptimeMs: bootObservation && Number.isSafeInteger(bootObservation.uptimeMs) ? bootObservation.uptimeMs : undefined,
            heartbeat: bootObservation && typeof bootObservation.heartbeatEnabled === "boolean" ? bootObservation.heartbeatEnabled : null,
            heartbeatStatus: bootObservation ? [
                Number.isSafeInteger(bootObservation.heartbeatPrimaryStatus) ? bootObservation.heartbeatPrimaryStatus : null,
                Number.isSafeInteger(bootObservation.heartbeatSecondaryStatus) ? bootObservation.heartbeatSecondaryStatus : null,
            ] : undefined,
            disks: bootObservation && Number.isSafeInteger(bootObservation.hardDiskCount) ? bootObservation.hardDiskCount : undefined,
            dvds: bootObservation && Number.isSafeInteger(bootObservation.dvdCount) ? bootObservation.dvdCount : undefined,
            boot: bootObservation && Array.isArray(bootObservation.bootDeviceTypes)
                    ? bootObservation.bootDeviceTypes.filter((candidate: unknown) => ["hard-disk", "dvd", "network", "unknown"].includes(String(candidate))).slice(0, 3)
                    : undefined,
        })
        : "";
    const boundedDetail = (candidate: unknown) => {
        if (typeof candidate !== "string" || candidate.length === 0) return "";
        const codes = candidate.match(/\b(?:appium|broker|hyper-v|powershell|ssh)-[a-z0-9-]{2,128}\b/g) || [];
        if (codes.length > 0) return [...new Set(codes)].slice(0, 4).join(",");
        return candidate.length <= 160 ? candidate : `${candidate.slice(0, 157)}...`;
    };
    const parts = [
        value?.error,
        body?.error,
        bootDiagnostic ? `boot=${bootDiagnostic}` : "",
        bootDiagnostic ? "" : boundedDetail(value?.detail),
        bootDiagnostic ? "" : boundedDetail(body?.detail),
        diagnostic,
        transportDiagnostic,
    ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);
    const message = [...new Set(parts)].join(": ") || fallback;
    return message.slice(0, 4095);
}

export function parseContractToolPayload<K extends keyof DeviceLabToolOutputMap>(name: K, result: any): DeviceLabToolOutputMap[K] {
    if (!hasDeviceLabOutputContract(name)) throw new Error(`No output contract registered for ${name}`);
    if (DEVICE_LAB_OUTPUT_CONTRACTS[name] === "image-content-v1") return validateDeviceLabToolOutput(name, result);
    return validateDeviceLabToolOutput(name, parseToolPayload(result));
}

export function lifecycleDevice(payload: any, operation: string): DeviceRecord {
    const device = payload?.device || payload?.result?.device;
    if (device && typeof device === "object" && !Array.isArray(device)) return device;
    throw new Error(`${operation} returned no device: ${JSON.stringify(payload)}`);
}

export function parseToolResult(result, options: any = {}) {
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
