import { TOOLS, toolOperation, isSimpleAction, CREATE_TOOL_BACKENDS } from "../../device-lab-mcp/src/tools.mjs";
import { brokerDeviceToolExecutionTimeout } from "../../device-lab-mcp/src/domain/device-request.mjs";
import { isSnapshotTool } from "@ccc/device-lab/device-lab/domain/lifecycle/hyper-v-snapshots.js";
import { createHash, randomUUID } from "crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "path";
import { constants as osConstants } from "os";
import { DEVICE_LAB_OUTPUT_CONTRACTS, hasDeviceLabOutputContract, validateDeviceLabToolOutput } from "../../device-lab-mcp/src/contracts/tool-contracts.mjs";
import type { DeviceLabToolOutputMap, DeviceRecord } from "../../device-lab-mcp/src/contracts/tool-contracts.mjs";
import { repoRoot } from "./helpers.ts";

const TOOL_CALLS_KEY = Symbol.for("ccc.deviceLabRealTests.toolCalls");
const TOOL_SESSIONS_KEY = Symbol.for("ccc.deviceLabRealTests.toolSessions");
const PUBLIC_TOOL_NAMES = new Set(TOOLS.map(tool => tool.name));
const PUBLIC_ARGUMENT_NAMES = new Set(TOOLS.flatMap(tool => Object.keys(tool.inputSchema?.properties || {})));

function knownToolName(value: unknown): string | undefined {
    return typeof value === "string" && PUBLIC_TOOL_NAMES.has(value) ? value : undefined;
}

function boundedValidationFailure(value: any) {
    const message = value?.body?.error ?? value?.error;
    if (typeof message !== "string") return undefined;
    const match = /^([a-z_]+) does not support ([A-Za-z][A-Za-z0-9]*)$/.exec(message);
    // The rejected field is absent from this tool, but must exist in the public
    // catalog. Arbitrary unknown keys can contain private caller information.
    if (!match || match[0] !== message || !knownToolName(match[1]) || !PUBLIC_ARGUMENT_NAMES.has(match[2])) return undefined;
    return { kind: "unsupported-argument", tool: match[1], field: match[2] };
}
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
const HYPER_V_LINUX_GUI_TIMEOUT_MS = 17 * 60 * 1000;
const HYPER_V_CLEANUP_RESERVE_MS = 5 * 60 * 1000;
const REAL_MCP_CLIENT_RPC_BUFFER_MS = 30000;
const HYPER_V_LIFECYCLE_TOOLS = new Set([
    ...Object.keys(CREATE_TOOL_BACKENDS),
    "status",
    "start",
    "stop",
    "reboot",
    "delete",
]);

function boundedBrokerDiagnosticCode(value: unknown): string | undefined {
    return typeof value === "string" && /^[a-z0-9-]{1,80}$/.test(value)
        ? value
        : undefined;
}

export function realMcpToolRequestTimeoutMs(name: string, args: Record<string, any> = {}) {
    const creationBackend = CREATE_TOOL_BACKENDS[name];
    const hyperVBackend = creationBackend === "windows-vm" || creationBackend === "linux-vm" || args?.backend === "windows-vm" || args?.backend === "linux-vm";
    if (hyperVBackend && creationBackend) {
        return HYPER_V_MAX_SERVER_RPC_TIMEOUT_MS + REAL_MCP_CLIENT_RPC_BUFFER_MS;
    }
    if (hyperVBackend && (name === "start" || name === "reboot")) {
        const bootTimeoutMs = args?.waitForBoot === false
            ? 0
            : Number.isFinite(args?.bootTimeoutMs)
                ? Math.min(HYPER_V_MAX_BOOT_TIMEOUT_MS, Math.max(1000, Number(args.bootTimeoutMs)))
                : 5 * 60 * 1000;
        const automaticRpcTimeoutMs = HYPER_V_HOST_LOCK_WAIT_MS
            + HYPER_V_PROVIDER_LIFECYCLE_TIMEOUT_MS
            + bootTimeoutMs
            + (args?.backend === "linux-vm" && args?.waitForBoot !== false ? HYPER_V_LINUX_GUI_TIMEOUT_MS : 0)
            + (args?.waitForBoot !== false ? HYPER_V_CLEANUP_RESERVE_MS : 0)
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
    const timeoutMs = Number(args?.timeoutMs);
    if (Number.isFinite(timeoutMs)) {
        return Math.min(MAX_REAL_MCP_TOOL_TIMEOUT_MS, Math.max(DEFAULT_REAL_MCP_TOOL_TIMEOUT_MS, timeoutMs + 30000));
    }
    const operation = toolOperation(name, args);
    if (operation && isSnapshotTool(operation)) {
        const serverTimeoutMs = brokerDeviceToolExecutionTimeout(operation, args).rpcTimeoutMs ?? 0;
        return Math.min(MAX_REAL_MCP_TOOL_TIMEOUT_MS, Math.max(
            DEFAULT_REAL_MCP_TOOL_TIMEOUT_MS,
            serverTimeoutMs + REAL_MCP_CLIENT_RPC_BUFFER_MS,
        ));
    }
    if (name === "create_android_emulator" && Boolean(args?.systemImage)) return LONG_REAL_MCP_TOOL_TIMEOUT_MS;
    if (name === "start" && args?.waitForBoot === true) {
        const bootTimeoutMs = Number(args?.bootTimeoutMs);
        return Number.isFinite(bootTimeoutMs)
            ? Math.min(MAX_REAL_MCP_TOOL_TIMEOUT_MS, Math.max(DEFAULT_REAL_MCP_TOOL_TIMEOUT_MS, bootTimeoutMs + 30000))
            : LONG_REAL_MCP_TOOL_TIMEOUT_MS;
    }
    if (name === "delete" && args?.deleteAvd === true) return LONG_REAL_MCP_TOOL_TIMEOUT_MS;
    if (name === "device_broker_appium" || name === "clipboard") {
        return LONG_REAL_MCP_TOOL_TIMEOUT_MS;
    }
    if (typeof args?.backend === "string" && args.backend.startsWith("ios") && (toolOperation(name, args)?.startsWith("mobile_") || ["click", "key", "type"].includes(name))) {
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
        if (content.length === 1 && content[0]?.type === "text" && content[0].text === "ok") summary.okPayloadAction = true;
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
        if (content.length === 1 && content[0]?.type === "text" && content[0].text === "ok") summary.okPayloadAction = true;
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

const PROOF_BACKENDS = new Set(["android-emulator", "android-device", "ios-simulator", "ios-device", "windows-vm", "windows-sandbox", "linux-vm", "macos-vm", "x11-current-display"]);

// Session-scoped evidence only: a successful owner inventory or lifecycle result
// must identify the device before later image/"ok" responses earn provider credit.
export function createTargetBackendEvidence() {
    const identities = new Map<string, Set<string>>();
    const stateBackends = { android: "android-emulator", "android-device": "android-device", ios: "ios-simulator", "ios-device": "ios-device", windows: "windows-sandbox", macos: "macos-vm", "windows-vm": "windows-vm", "linux-vm": "linux-vm" };
    const validBackend = (value: unknown) => value === "x11" ? "x11-current-display"
        : typeof value === "string" && PROOF_BACKENDS.has(value) ? value : undefined;
    const remember = (device: any, inherited?: string) => {
        if (!device || typeof device !== "object" || Array.isArray(device) || device.ok === false || device.error) return;
        const backend = validBackend(device.backend) || inherited;
        const id = device.deviceId;
        if (typeof id !== "string" || !id || !backend) return;
        const known = identities.get(id) || new Set<string>();
        known.add(backend);
        identities.set(id, known);
    };
    const lookup = (id: unknown) => {
        const known = typeof id === "string" ? identities.get(id) : undefined;
        return known?.size === 1 ? [...known][0] : undefined;
    };
    return {
        lookup,
        observe(name: string, args: Record<string, any>, result: any) {
            if (result?.isError === true) return undefined;
            if (![...Object.keys(CREATE_TOOL_BACKENDS), "attach", "devices", "status"].includes(name)) return lookup(args.deviceId);
            const payload: any = jsonContentPayload(resultContent(result));
            if (payload?.ok === false || payload?.error) return undefined;
            const selector = CREATE_TOOL_BACKENDS[name] || (["attach", "devices"].includes(name) ? validBackend(args.backend) : undefined);
            const observeEnvelope = (value: any, inherited?: string) => {
                if (!value || typeof value !== "object" || value.ok === false || value.error) return;
                const backend = validBackend(value.backend) || validBackend(stateBackends[value.stateKey]) || inherited;
                if (Array.isArray(value)) value.forEach(device => remember(device, backend));
                else {
                    remember(value, backend);
                    remember(value.device, backend);
                    for (const device of Array.isArray(value.devices) ? value.devices : []) remember(device, backend);
                    for (const group of Array.isArray(value.backends) ? value.backends : []) {
                        if (!group || group.ok === false || group.error) continue;
                        const groupBackend = validBackend(group.backend) || validBackend(stateBackends[group.stateKey]);
                        for (const device of Array.isArray(group.devices) ? group.devices : []) remember(device, groupBackend);
                    }
                }
            };
            observeEnvelope(payload, selector);
            observeEnvelope(payload?.result, validBackend(payload?.backend) || selector);
            return lookup(args.deviceId);
        },
    };
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

// This check is independent of the raw fingerprints retained in coverage evidence.
// Schema annotations may change without changing the invocation contract.
function canonicalSchema(value: any, schema = true): any {
    if (Array.isArray(value)) return value.map(item => canonicalSchema(item, schema));
    if (!value || typeof value !== "object") return value;
    const maps = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
    const children = new Set(["items", "prefixItems", "additionalProperties", "unevaluatedProperties", "propertyNames", "contains", "allOf", "anyOf", "oneOf", "not", "if", "then", "else"]);
    return Object.fromEntries(Object.keys(value).sort().filter(key => !schema || !["description", "title", "$comment", "examples"].includes(key)).map(key => {
        const entry = value[key];
        if (schema && maps.has(key) && entry && typeof entry === "object") {
            return [key, Object.fromEntries(Object.keys(entry).sort().map(name => [name, canonicalSchema(entry[name])]))];
        }
        return [key, canonicalSchema(entry, schema && children.has(key))];
    }));
}

export function mcpToolSurfaceMatches(tools: any): boolean {
    if (!Array.isArray(tools) || tools.length !== TOOLS.length) return false;
    const names = tools.map(tool => tool?.name);
    if (new Set(names).size !== names.length) return false;
    const expected = new Map(TOOLS.map(tool => [tool.name, JSON.stringify(canonicalSchema(tool.inputSchema))]));
    return tools.every(tool => expected.has(tool?.name)
        && expected.get(tool.name) === JSON.stringify(canonicalSchema(tool.inputSchema)));
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
        if (listed.nextCursor || !mcpToolSurfaceMatches(listed.tools)) {
            throw new Error("device-lab-mcp-contract-mismatch: rebuild with npm run build before running real-provider tests");
        }
        const targetBackends = createTargetBackendEvidence();
        const callTool = async (name: string, args: Record<string, any> = {}) => {
            // Record exactly what JSON-RPC sends, not mutable JS inputs containing
            // undefined properties that disappear at the transport boundary.
            args = JSON.parse(JSON.stringify(args));
            const record: Record<string, any> = { name, arguments: args, outcome: "pending", mcpSessionId: sessionId };
            toolCalls().push(record);
            try {
                const knownBackend = targetBackends.lookup(args.deviceId);
                const timeout = realMcpToolRequestTimeoutMs(name, knownBackend ? { ...args, backend: knownBackend } : args);
                const result = await client.callTool(
                    { name, arguments: args },
                    undefined,
                    { timeout, maxTotalTimeout: timeout },
                );
                record.outcome = result?.isError === true ? "error-result" : "ok";
                record.isError = result?.isError === true;
                Object.assign(record, summarizeToolResultForProof(result));
                const observedBackend = targetBackends.observe(name, args, result);
                if (observedBackend) record.observedBackend = observedBackend;
                if (name === "run_flow") {
                    try {
                        const payload = jsonContentPayload(resultContent(result)) || {};
                        if (Array.isArray(payload?.results)) {
                            record.flowSteps = payload.results.map((step, index) => ({ ...summarizeFlowStepPayload(step), simpleAction: isSimpleAction(step.tool, toolOperation(step.tool, args.steps?.[index]?.arguments)) })).filter((step) => step.tool);
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
                return parseContractToolPayload(name, await callTool(name, args), args);
            },
        });
    } finally {
        await client.close();
    }
}

export function parseToolPayload(result) {
    const text = result?.content?.[0]?.text || "{}";
    if (result?.isError) {
        const structuredContent = result?.structuredContent;
        const value = structuredContent && typeof structuredContent === "object" && !Array.isArray(structuredContent)
            && (structuredContent.ok === false || typeof structuredContent.error === "string")
            ? structuredContent : jsonContentPayload(resultContent(result));
        const structured = value && typeof value === "object" && !Array.isArray(value) ? value : null;
        const tool = knownToolName(result?.__cccToolCallRecord?.name);
        let message = formatBrokerToolFailure(structured, "mcp-tool-failed", tool);
        if (structured?.error === "broker-runtime-process-unverified") {
            message = "broker-runtime-process-unverified: Broker identity unverified; automatic restart was refused.";
        }
        const relativePath = `results/device-lab-real/mcp-error-${randomUUID()}.json`;
        try {
            mkdirSync(join(repoRoot, "results", "device-lab-real"), { recursive: true });
            writeFileSync(join(repoRoot, relativePath), JSON.stringify({
                schemaVersion: 1,
                failure: brokerToolFailureEvidence(structured, tool),
                privacy: "Host paths, credentials, endpoints and raw command output are omitted.",
            }, null, 2) + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
            message += ` Diagnostics: ${relativePath}`;
        } catch {
            message += " Diagnostics could not be saved.";
        }
        const error = new Error(message);
        if (structured) Object.defineProperty(error, "brokerPayload", { value: structured });
        throw error;
    }
    const payload = jsonContentPayload(resultContent(result));
    if (payload) return payload;
    return JSON.parse(text);
}

function boundedDiagnosticText(value: unknown, maxLength = 128): string | undefined {
    return typeof value === "string"
        && value.length <= maxLength
        && /^[A-Za-z0-9 ._:+-]*$/.test(value)
        ? value
        : undefined;
}

function safeNonNegativeInteger(value: unknown): number | null | undefined {
    if (value === null) return null;
    return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function boundedSimctlFailure(value: any) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const errors: Array<{ domain: string; code: number }> = [];
    if (Array.isArray(value.errors)) for (const error of value.errors.slice(0, 32)) {
        if (["NSPOSIXErrorDomain", "NSCocoaErrorDomain", "com.apple.CoreSimulator.SimError", "com.apple.CoreSimulator.LaunchdSimError", "SimXPCErrorDomain"].includes(error?.domain)
            && Number.isInteger(error.code) && error.code >= -2147483648 && error.code <= 2147483647
            && !errors.some(prior => prior.domain === error.domain && prior.code === error.code)) {
            errors.push({ domain: error.domain, code: error.code });
            if (errors.length === 4) break;
        }
    }
    const stage = value.stage === "spawn" ? "spawn" : undefined;
    return errors.length || stage ? { ...(errors.length ? { errors } : {}), ...(stage ? { stage } : {}) } : undefined;
}

function boundedNativeExecution(value: any) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const status = safeNonNegativeInteger(value.status);
    const signal = value.signal === null ? null
        : typeof value.signal === "string" && Object.hasOwn(osConstants.signals, value.signal) ? value.signal : undefined;
    const errorCode = typeof value.errorCode === "string" && Object.hasOwn(osConstants.errno, value.errorCode)
        ? value.errorCode : undefined;
    const diagnosticCode = ["native-timeout", "native-not-found", "native-permission-denied", "native-signal", "native-nonzero-exit", "native-unknown"].includes(value.diagnosticCode)
        ? value.diagnosticCode : undefined;
    const timedOut = typeof value.timedOut === "boolean" ? value.timedOut : undefined;
    const simctl = boundedSimctlFailure(value.simctl);
    return status !== undefined || signal !== undefined || errorCode || diagnosticCode || timedOut !== undefined || simctl
        ? { status, signal, timedOut, errorCode, diagnosticCode, ...(simctl ? { simctl } : {}) } : undefined;
}

function providerExecution(value: any) {
    const payload = value?.body && typeof value.body === "object" && !Array.isArray(value.body) ? value.body : value;
    return payload?.execution ?? payload?.result?.execution?.command;
}

function boundedMacosBoot(value: any) {
    const boot = providerExecution(value)?.macosBoot;
    if (!boot || typeof boot !== "object" || Array.isArray(boot) || typeof boot.ok !== "boolean") return undefined;
    // The renderer's error text includes an instance name. Export only its fixed category.
    const diagnosticCode = boot.error?.error === "missing-provider-metadata: providerInstance"
        ? "missing-provider-metadata"
        : typeof boot.error?.error === "string" && boot.error.error.startsWith("Timed out waiting for Tart IP for ")
            ? "macos-tart-ip-timeout" : undefined;
    return { phase: "ip-readiness", ok: boot.ok, diagnosticCode,
        execution: boundedNativeExecution(boot.error),
        attemptCount: Array.isArray(boot.attempts) ? Math.min(boot.attempts.length, 10000) : undefined,
    };
}

function boundedProcessObservation(value: any) {
    if (!value || typeof value !== "object" || Array.isArray(value)
        || !["listener", "command", "start-token", "identity"].includes(value.stage)
        || !["native-command-failed", "native-output-unavailable", "budget-exhausted", "invalid-runtime", "listener-pid-mismatch", "status-identity-unverified", "runtime-continuity-unverified", "command-line-unverified"].includes(value.reason)) return undefined;
    return { stage: value.stage, reason: value.reason,
        ...boundedNativeExecution({ status: value.status, signal: value.signal, errorCode: value.code }),
    };
}

function boundedTransportRecoveryAttempt(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const attempt = value as Record<string, unknown>;
    return {
        port: safeNonNegativeInteger(attempt.port),
        status: safeNonNegativeInteger(attempt.status),
        error: boundedBrokerDiagnosticCode(attempt.error),
        durationMs: safeNonNegativeInteger(attempt.durationMs),
        brokerDiagnostics: Array.isArray(attempt.brokerDiagnostics)
            ? attempt.brokerDiagnostics.slice(0, 8).map(boundedBrokerDiagnosticCode).filter(Boolean)
            : [],
    };
}

function boundedHyperVReadiness(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const readiness = value as Record<string, unknown>;
    return {
        managedSshAttempts: safeNonNegativeInteger(readiness.managedSshAttempts),
        bootstrapProbeAttempts: safeNonNegativeInteger(readiness.bootstrapProbeAttempts),
        bootstrapProbeSuccesses: safeNonNegativeInteger(readiness.bootstrapProbeSuccesses),
        bootstrapProbeLastStatus: safeNonNegativeInteger(readiness.bootstrapProbeLastStatus),
        bootstrapProbeLastError: boundedBrokerDiagnosticCode(readiness.bootstrapProbeLastError),
        bootstrapAddressCount: safeNonNegativeInteger(readiness.bootstrapAddressCount),
        bootstrapSshAttempts: safeNonNegativeInteger(readiness.bootstrapSshAttempts),
        bootstrapSshLastStatus: safeNonNegativeInteger(readiness.bootstrapSshLastStatus),
        bootstrapSshLastError: boundedBrokerDiagnosticCode(readiness.bootstrapSshLastError),
        ...(typeof readiness.bootstrapHostKeyObserved === "boolean"
            ? { bootstrapHostKeyObserved: readiness.bootstrapHostKeyObserved } : {}),
        ...(typeof readiness.bootstrapHostKeyMatchesExpected === "boolean"
            ? { bootstrapHostKeyMatchesExpected: readiness.bootstrapHostKeyMatchesExpected } : {}),
        networkFinalizeAttempts: safeNonNegativeInteger(readiness.networkFinalizeAttempts),
        ...(typeof readiness.networkFinalizeSucceeded === "boolean"
            ? { networkFinalizeSucceeded: readiness.networkFinalizeSucceeded } : {}),
        ...(typeof readiness.guestSignalObserved === "boolean"
            ? { guestSignalObserved: readiness.guestSignalObserved } : {}),
        elapsedMs: safeNonNegativeInteger(readiness.elapsedMs),
    };
}

// The typed primitive behind a Hyper-V create failure: a closed Verb-Noun cmdlet name, never host text.
function boundedHyperVOperation(value: unknown): string | undefined {
    return typeof value === "string" && /^[A-Z][a-z]{1,15}-[A-Z][A-Za-z]{1,31}$/.test(value)
        ? value
        : undefined;
}

// A failed create's compensation, reduced to codes. The broker reports it in two shapes: the
// create-residue reconcile ({ok, status, error, detail, stage}) and the post-create rollback
// ({ok, reason, stage, allocation, artifacts, result}). In the second, a failed network release
// leaves the artifacts unattempted, so the allocation's own code is read first.
function boundedBrokerRollback(value: any) {
    const body = value?.body && typeof value.body === "object" && !Array.isArray(value.body) ? value.body : null;
    const rollback = body?.rollback ?? value?.rollback;
    if (!rollback || typeof rollback !== "object" || Array.isArray(rollback) || typeof rollback.ok !== "boolean") {
        return undefined;
    }
    const part = (candidate: unknown) => candidate && typeof candidate === "object" && !Array.isArray(candidate)
        ? candidate as Record<string, unknown>
        : null;
    const allocation = part(rollback.allocation);
    const artifacts = part(rollback.artifacts);
    const result = part(rollback.result);
    const status = safeNonNegativeInteger(rollback.status);
    const error = boundedBrokerDiagnosticCode(rollback.error) || boundedBrokerDiagnosticCode(rollback.reason);
    const detail = boundedBrokerDiagnosticCode(rollback.detail)
        || (allocation?.ok === false ? boundedBrokerDiagnosticCode(allocation.error) : undefined)
        || (artifacts?.ok === false ? boundedBrokerDiagnosticCode(artifacts.error) : undefined)
        || (rollback.ok === false ? boundedBrokerDiagnosticCode(result?.diagnosticCode) : undefined);
    const stage = boundedBrokerDiagnosticCode(rollback.stage);
    return {
        ok: rollback.ok as boolean,
        ...(typeof status === "number" ? { status } : {}),
        ...(error ? { error } : {}),
        ...(detail && detail !== error ? { detail } : {}),
        ...(stage ? { stage } : {}),
    };
}

// "rollback=<error>/<detail>" for a failed compensation, "rollback=ok" for a clean one, or "".
export function brokerRollbackSummary(value: any): string {
    const rollback = boundedBrokerRollback(value);
    if (!rollback) return "";
    if (rollback.ok) return "rollback=ok";
    return `rollback=${rollback.error || "failed"}${rollback.detail ? `/${rollback.detail}` : ""}`;
}

// The create failure behind a failed allocation compensation. The broker's create wrapper reports
// that compensation at the top level (hyper-v-create-allocation-cleanup-failed) and the failure it
// was compensating as `lifecycleFailure`, which is reduced here to codes like the rest.
function nativeFailureNumbers(value: any) {
    const fields: Record<string, number> = {};
    if (Number.isInteger(value?.nativeHResult) && value.nativeHResult >= -2147483648 && value.nativeHResult <= 2147483647) fields.nativeHResult = value.nativeHResult;
    if (Number.isInteger(value?.nativeErrorCategory) && value.nativeErrorCategory >= 0 && value.nativeErrorCategory <= 31) fields.nativeErrorCategory = value.nativeErrorCategory;
    return fields;
}

function boundedDesktopReadiness(value: any) {
    if (!value || !["not-attempted", "provider-error", "transport-exception", "missing-cursor", "late-response"].includes(value.lastProbe)) return undefined;
    const attempts = safeNonNegativeInteger(value.attempts);
    if (attempts == null) return undefined;
    const helper: Record<string, boolean | number | string> = {};
    if (["login-unavailable", "timeout", "command-failed"].includes(value.helper?.bootstrapFailure)) helper.bootstrapFailure = value.helper.bootstrapFailure;
    for (const key of ["bootstrapDeadlineExhausted", "readyMarkerPresent", "bootstrapAttempted", "bootstrapOk", "requestAttempted", "requestOk", "responseParseFailed"]) {
        if (typeof value.helper?.[key] === "boolean") helper[key] = value.helper[key];
    }
    if (Number.isInteger(value.helper?.guestStatus) && value.helper.guestStatus >= -2147483648 && value.helper.guestStatus <= 2147483647) helper.guestStatus = value.helper.guestStatus;
    const stage = ["sandbox-id-invalid", "prerequisites-missing", "session-connect-failed", "response-rejected", "response-timeout"].includes(value.helper?.stage)
        ? value.helper.stage as string : undefined;
    const logEvidence: Record<string, string | boolean> = {};
    for (const key of ["bootstrapStarted", "bootstrapReady", "helperHeartbeat"]) {
        if (typeof value.helper?.logEvidence?.[key] === "boolean") logEvidence[key] = value.helper.logEvidence[key];
    }
    for (const key of ["bootstrapStderr", "helperStderr"]) {
        if (["absent", "empty", "access-denied", "path-not-found", "script-policy", "parse-error", "other-error", "unreadable", "oversized"].includes(value.helper?.logEvidence?.[key])) logEvidence[key] = value.helper.logEvidence[key];
    }
    const helperAttempt = Number.isSafeInteger(value.helperAttempt) && value.helperAttempt > 0 && value.helperAttempt <= attempts
        ? value.helperAttempt as number : undefined;
    const failure = boundedReadinessFailure(value.failure);
    const failureAttempt = Number.isSafeInteger(value.failureAttempt) && value.failureAttempt > 0 && value.failureAttempt <= attempts
        ? value.failureAttempt as number : undefined;
    return { attempts, lastProbe: value.lastProbe,
        ...(failure ? { failure, ...(failureAttempt !== undefined ? { failureAttempt } : {}) } : {}),
        ...(Object.keys(helper).length || stage || Object.keys(logEvidence).length ? { helper: { ...helper, ...(stage ? { stage } : {}), ...(Object.keys(logEvidence).length ? { logEvidence } : {}) },
            ...(helperAttempt !== undefined ? { helperAttempt } : {}) } : {}) };
}

// Revalidate readiness evidence at the saved-artifact boundary independently of
// the MCP adapter. Pattern-shaped or private error text is never a known code.
const READINESS_FAILURE_ERRORS: Record<string, readonly string[]> = {
    "broker-process": ["broker-runtime-process-unverified", "broker-runtime-generation-changed", "broker-incompatible-process-still-running", "broker-launch-failed"],
    "broker-transport": ["broker-rpc-unavailable", "broker-rpc-failed", "broker-owner-resolve-unavailable", "broker-owner-resolve-failed", "broker-owner-resolve-readiness-timeout", "broker-owner-auth-unavailable", "broker-launch-owner-resolve-timeout", "broker-launch-health-timeout", "host-broker-incompatible", "broker-response-too-large", "invalid-broker-json", "invalid-broker-content-length", "broker-redirect-disallowed", "broker-observation-budget-exhausted-before-rpc", "timeout", "connection-reset", "connection-refused", "broken-pipe", "response-aborted", "transport-error"],
    provider: ["provider-command-failed", "device-lab-backend-tool-failed", "device-lab-backend-tool-invalid-json", "device-lab-backend-module-missing", "windows-sandbox-helper-timeout", "windows-sandbox-helper-failed", "windows-sandbox-helper-response-rejected", "owner-device-not-found", "device-not-found", "device-backend-not-found", "owner-device-state-conflict", "device-tool-unsupported", "broker-device-tool-backend-not-supported", "broker-device-tool-not-supported"],
};

function boundedReadinessExecution(value: any) {
    const native = boundedNativeExecution(value);
    if (!native) return undefined;
    const { status, signal, errorCode, timedOut, diagnosticCode } = native;
    return status !== undefined || signal !== undefined || errorCode || timedOut !== undefined || diagnosticCode
        ? { ...(status !== undefined ? { status } : {}), ...(signal !== undefined ? { signal } : {}), ...(errorCode ? { errorCode } : {}),
            ...(timedOut !== undefined ? { timedOut } : {}), ...(diagnosticCode ? { diagnosticCode } : {}) }
        : undefined;
}

function boundedReadinessFailure(value: any) {
    if (!value || typeof value !== "object" || Array.isArray(value)
        || !["broker-process", "broker-transport", "provider"].includes(value.stage)) return undefined;
    const error = READINESS_FAILURE_ERRORS[value.stage].includes(value.error) ? value.error as string : undefined;
    const observation = value.stage === "broker-process" && value.processObservation
        ? boundedProcessObservation({ ...value.processObservation, code: value.processObservation.errorCode }) : undefined;
    const processObservation = observation ? { stage: observation.stage, reason: observation.reason,
        ...boundedReadinessExecution(observation) } : undefined;
    const execution = boundedReadinessExecution(value.execution);
    const nativeFailure = execution && ((typeof execution.status === "number" && execution.status !== 0) || execution.signal || execution.errorCode || execution.timedOut === true);
    if (!error && !processObservation && !(value.stage === "provider" && nativeFailure)) return undefined;
    return { stage: value.stage, ...(error ? { error } : {}),
        ...(processObservation ? { processObservation } : {}), ...(execution ? { execution } : {}) };
}

function boundedBrokerLifecycleFailure(value: any) {
    const body = value?.body && typeof value.body === "object" && !Array.isArray(value.body) ? value.body : null;
    const failure = body?.lifecycleFailure ?? value?.lifecycleFailure;
    if (!failure || typeof failure !== "object" || Array.isArray(failure)) return undefined;
    const error = boundedBrokerDiagnosticCode(failure.error);
    if (!error) return undefined;
    const detail = boundedBrokerDiagnosticCode(failure.detail);
    const operation = boundedHyperVOperation(failure.operation);
    return {
        error,
        ...(detail && detail !== error ? { detail } : {}),
        ...(operation ? { operation } : {}),
        ...nativeFailureNumbers(failure),
    };
}

export function brokerToolFailureEvidence(value: any, callName?: unknown) {
    const body = value?.body && typeof value.body === "object" && !Array.isArray(value.body) ? value.body : null;
    const attempts = Array.isArray(value?.attempts)
        ? value.attempts
        : Array.isArray(value?.launch?.attempts) ? value.launch.attempts : [];
    const lastAttempt = attempts.at(-1);
    const transportError = String(lastAttempt?.error || "").toLowerCase();
    const transportCode = boundedBrokerDiagnosticCode(lastAttempt?.transportCode)
        || (transportError.includes("timeout") ? "timeout"
            : transportError.includes("econnrefused") || transportError.includes("connection refused") ? "connection-refused"
                : transportError.includes("abort") ? "aborted"
                    : transportError.includes("fetch") ? "fetch-failed"
                        : transportError ? "transport-error" : undefined);
    const boot = body?.result?.boot && typeof body.result.boot === "object" && !Array.isArray(body.result.boot)
        ? body.result.boot
        : value?.result?.boot && typeof value.result.boot === "object" && !Array.isArray(value.result.boot)
            ? value.result.boot
            : null;
    const observation = boot?.diagnostic && typeof boot.diagnostic === "object" && !Array.isArray(boot.diagnostic)
        ? boot.diagnostic
        : null;
    const sanitizeController = (candidate: unknown) => ["ide", "scsi", ""].includes(String(candidate)) ? String(candidate) : undefined;
    const detail = boundedBrokerDiagnosticCode(body?.detail) || boundedBrokerDiagnosticCode(value?.detail);
    const operation = boundedHyperVOperation(body?.operation) || boundedHyperVOperation(value?.operation);
    const rollback = boundedBrokerRollback(value);
    const lifecycleFailure = boundedBrokerLifecycleFailure(value);
    const readiness = boundedDesktopReadiness(body?.readiness ?? value?.readiness);
    const validation = boundedValidationFailure(value);
    const tool = knownToolName(callName);
    const execution = boundedNativeExecution(providerExecution(value));
    const macosBoot = boundedMacosBoot(value);
    const processObservation = boundedProcessObservation(lastAttempt?.processVerification?.observation);
    const evidence: Record<string, unknown> = {
        ...(tool ? { tool } : {}),
        ...(execution ? { execution } : {}),
        ...(macosBoot ? { macosBoot } : {}),
        ...(processObservation ? { processObservation } : {}),
        ...(validation ? { validation } : {}),
        error: boundedBrokerDiagnosticCode(value?.error),
        bodyError: boundedBrokerDiagnosticCode(body?.error),
        ...(detail ? { detail } : {}),
        ...(operation ? { operation } : {}),
        ...(rollback ? { rollback } : {}),
        ...(lifecycleFailure ? { lifecycleFailure } : {}),
        ...nativeFailureNumbers(body ?? value),
        ...(readiness ? { readiness } : {}),
    };
    if (body?.error === "hyper-v-snapshot-inventory-conflict") {
        evidence.snapshotInventory = {
            untrackedCount: Array.isArray(body.untracked) ? Math.min(body.untracked.length, 1000) : null,
            missingCount: Array.isArray(body.missing) ? Math.min(body.missing.length, 1000) : null,
            observedOwnerSnapshotCount: safeNonNegativeInteger(body.observedOwnerSnapshotCount),
        };
    }
    if (lastAttempt && typeof lastAttempt === "object") {
        evidence.transport = {
            port: safeNonNegativeInteger(lastAttempt.port),
            status: safeNonNegativeInteger(lastAttempt.status),
            error: transportCode,
            durationMs: safeNonNegativeInteger(lastAttempt.durationMs),
            timeoutMs: safeNonNegativeInteger(lastAttempt.timeoutMs),
        };
        if (Array.isArray(lastAttempt.attempts)) {
            const finalProbe = lastAttempt.attempts.at(-1);
            evidence.recovery = {
                reason: boundedBrokerDiagnosticCode(lastAttempt.reason),
                probeCount: Math.min(lastAttempt.attempts.length, 10000),
                lastProbeError: boundedBrokerDiagnosticCode(finalProbe?.error),
                terminationReason: boundedBrokerDiagnosticCode(lastAttempt.termination?.reason),
            };
        }
    }
    if (value?.transportRecovery && typeof value.transportRecovery === "object") {
        evidence.transportRecovery = {
            attempted: value.transportRecovery.attempted === true,
            recovered: value.transportRecovery.recovered === true,
            initial: boundedTransportRecoveryAttempt(value.transportRecovery.initial),
            retry: boundedTransportRecoveryAttempt(value.transportRecovery.retry),
        };
    }
    const provisioning = value?.provisioning && typeof value.provisioning === "object"
        ? value.provisioning
        : body?.provisioning && typeof body.provisioning === "object" ? body.provisioning : null;
    if (provisioning) {
        evidence.provisioning = {
            status: safeNonNegativeInteger(provisioning.status),
            signal: boundedBrokerDiagnosticCode(provisioning.signal),
            error: boundedBrokerDiagnosticCode(provisioning.error),
            diagnosticCode: boundedBrokerDiagnosticCode(provisioning.diagnosticCode),
            outputOmitted: true,
        };
    }
    if (boot) {
        evidence.boot = {
            provider: boundedBrokerDiagnosticCode(boot.provider),
            error: boundedBrokerDiagnosticCode(boot.error),
            readiness: boundedHyperVReadiness(boot.readiness),
            diagnosticAvailable: typeof boot.diagnosticAvailable === "boolean" ? boot.diagnosticAvailable : undefined,
            diagnosticError: boundedBrokerDiagnosticCode(boot.diagnosticError),
            diagnostic: observation ? {
                state: boundedDiagnosticText(observation.state, 64),
                uptimeMs: safeNonNegativeInteger(observation.uptimeMs),
                generation: observation.generation === 1 || observation.generation === 2 ? observation.generation : null,
                secureBootEnabled: typeof observation.secureBootEnabled === "boolean" ? observation.secureBootEnabled : null,
                heartbeatEnabled: typeof observation.heartbeatEnabled === "boolean" ? observation.heartbeatEnabled : null,
                heartbeatPrimaryStatus: safeNonNegativeInteger(observation.heartbeatPrimaryStatus),
                heartbeatSecondaryStatus: safeNonNegativeInteger(observation.heartbeatSecondaryStatus),
                integrationServices: Array.isArray(observation.integrationServices)
                    ? observation.integrationServices.slice(0, 16).flatMap((candidate: unknown) => {
                        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
                        const service = candidate as Record<string, unknown>;
                        const name = boundedDiagnosticText(service.name, 128);
                        return name ? [{
                            name,
                            enabled: service.enabled === true,
                            primaryStatus: safeNonNegativeInteger(service.primaryStatus),
                            secondaryStatus: safeNonNegativeInteger(service.secondaryStatus),
                        }] : [];
                    }) : [],
                hardDiskCount: safeNonNegativeInteger(observation.hardDiskCount),
                dvdCount: safeNonNegativeInteger(observation.dvdCount),
                hardDiskControllers: Array.isArray(observation.hardDiskControllers)
                    ? observation.hardDiskControllers.slice(0, 8).map(sanitizeController).filter(Boolean) : [],
                bootDeviceTypes: Array.isArray(observation.bootDeviceTypes)
                    ? observation.bootDeviceTypes.slice(0, 8).filter((candidate: unknown) => ["hard-disk", "dvd", "network", "unknown"].includes(String(candidate))) : [],
                bootEntries: Array.isArray(observation.bootEntries)
                    ? observation.bootEntries.slice(0, 8).flatMap((candidate: unknown) => {
                        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
                        const entry = candidate as Record<string, unknown>;
                        return [{
                            bootType: boundedDiagnosticText(entry.bootType, 64),
                            deviceType: boundedDiagnosticText(entry.deviceType, 128),
                            controllerType: boundedDiagnosticText(entry.controllerType, 32),
                            controllerNumber: safeNonNegativeInteger(entry.controllerNumber),
                            controllerLocation: safeNonNegativeInteger(entry.controllerLocation),
                        }];
                    }) : [],
                hardDisks: Array.isArray(observation.hardDisks)
                    ? observation.hardDisks.slice(0, 8).flatMap((candidate: unknown) => {
                        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
                        const disk = candidate as Record<string, unknown>;
                        return [{
                            controllerType: sanitizeController(disk.controllerType),
                            controllerNumber: safeNonNegativeInteger(disk.controllerNumber),
                            controllerLocation: safeNonNegativeInteger(disk.controllerLocation),
                            vhdFormat: boundedDiagnosticText(disk.vhdFormat, 32),
                            vhdType: boundedDiagnosticText(disk.vhdType, 32),
                            sizeBytes: safeNonNegativeInteger(disk.sizeBytes),
                            fileSizeBytes: safeNonNegativeInteger(disk.fileSizeBytes),
                            minimumSizeBytes: safeNonNegativeInteger(disk.minimumSizeBytes),
                            logicalSectorSize: safeNonNegativeInteger(disk.logicalSectorSize),
                            physicalSectorSize: safeNonNegativeInteger(disk.physicalSectorSize),
                        }];
                    }) : [],
                dvdDrives: Array.isArray(observation.dvdDrives)
                    ? observation.dvdDrives.slice(0, 8).flatMap((candidate: unknown) => {
                        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
                        const dvd = candidate as Record<string, unknown>;
                        return [{
                            controllerType: sanitizeController(dvd.controllerType),
                            controllerNumber: safeNonNegativeInteger(dvd.controllerNumber),
                            controllerLocation: safeNonNegativeInteger(dvd.controllerLocation),
                            mediaAttached: dvd.mediaAttached === true,
                        }];
                    }) : [],
                diagnosticComplete: typeof observation.diagnosticComplete === "boolean" ? observation.diagnosticComplete : undefined,
                diagnosticErrors: Array.isArray(observation.diagnosticErrors)
                    ? observation.diagnosticErrors.slice(0, 16).map(boundedBrokerDiagnosticCode).filter(Boolean) : [],
            } : null,
        };
    }
    return evidence;
}

export function formatBrokerToolFailure(value: any, fallback: string, callName?: unknown) {
    const body = value?.body && typeof value.body === "object" && !Array.isArray(value.body)
        ? value.body
        : null;
    const provisioning = value?.provisioning && typeof value.provisioning === "object"
        ? value.provisioning
        : body?.provisioning && typeof body.provisioning === "object"
            ? body.provisioning
            : null;
    const executionCandidate = value?.execution && typeof value.execution === "object"
        ? value.execution
        : body?.execution && typeof body.execution === "object"
            ? body.execution
            : null;
    const redactedExecution = executionCandidate?.outputRedacted === true ? executionCandidate : null;
    const diagnostic = provisioning
        ? JSON.stringify({
            status: safeNonNegativeInteger(provisioning.status),
            signal: boundedBrokerDiagnosticCode(provisioning.signal),
            error: boundedBrokerDiagnosticCode(provisioning.error),
            diagnosticCode: boundedBrokerDiagnosticCode(provisioning.diagnosticCode),
        })
        : redactedExecution
            ? JSON.stringify({
                status: Number.isSafeInteger(redactedExecution.status) ? redactedExecution.status : undefined,
                signal: boundedBrokerDiagnosticCode(redactedExecution.signal),
                timedOut: typeof redactedExecution.timedOut === "boolean" ? redactedExecution.timedOut : undefined,
                diagnosticCode: boundedBrokerDiagnosticCode(redactedExecution.diagnosticCode),
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
    const transportErrorCode = boundedBrokerDiagnosticCode(lastAttempt?.transportCode)
        ? boundedBrokerDiagnosticCode(lastAttempt.transportCode)
        : transportError.includes("timeout")
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
    const transportRecovery = value?.transportRecovery && typeof value.transportRecovery === "object"
        ? JSON.stringify({
            attempted: value.transportRecovery.attempted === true,
            recovered: value.transportRecovery.recovered === true,
            initial: boundedTransportRecoveryAttempt(value.transportRecovery.initial),
            retry: boundedTransportRecoveryAttempt(value.transportRecovery.retry),
        })
        : "";
    const brokerProcessDiagnostic = lastAttempt?.processVerification
        ? JSON.stringify({
            reason: boundedBrokerDiagnosticCode(lastAttempt.reason),
            source: boundedBrokerDiagnosticCode(lastAttempt.processVerification.source),
            port: Number.isFinite(value?.port) ? value.port : undefined,
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
            provider: boundedBrokerDiagnosticCode(boot.provider),
            error: boundedBrokerDiagnosticCode(boot.error),
            readiness: boundedHyperVReadiness(boot.readiness),
            diagnosticError: boundedBrokerDiagnosticCode(boot.diagnosticError),
            state: bootObservation ? boundedDiagnosticText(bootObservation.state, 64) : undefined,
            uptimeMs: bootObservation && Number.isSafeInteger(bootObservation.uptimeMs) ? bootObservation.uptimeMs : undefined,
            generation: bootObservation && (bootObservation.generation === 1 || bootObservation.generation === 2) ? bootObservation.generation : undefined,
            secureBoot: bootObservation && typeof bootObservation.secureBootEnabled === "boolean" ? bootObservation.secureBootEnabled : null,
            heartbeat: bootObservation && typeof bootObservation.heartbeatEnabled === "boolean" ? bootObservation.heartbeatEnabled : null,
            heartbeatStatus: bootObservation ? [
                Number.isSafeInteger(bootObservation.heartbeatPrimaryStatus) ? bootObservation.heartbeatPrimaryStatus : null,
                Number.isSafeInteger(bootObservation.heartbeatSecondaryStatus) ? bootObservation.heartbeatSecondaryStatus : null,
            ] : undefined,
            // Actionable guest-readiness fields first so they survive the 511-char message cap
            // (bulky disk/boot topology arrays follow and may be truncated without losing the cause).
            diagnosticComplete: bootObservation && typeof bootObservation.diagnosticComplete === "boolean" ? bootObservation.diagnosticComplete : undefined,
            diagnosticErrors: bootObservation && Array.isArray(bootObservation.diagnosticErrors)
                ? bootObservation.diagnosticErrors.map(boundedBrokerDiagnosticCode).filter(Boolean).slice(0, 8)
                : undefined,
            services: bootObservation && Array.isArray(bootObservation.integrationServices)
                ? bootObservation.integrationServices.slice(0, 8).map((candidate: unknown) => {
                    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
                    const service = candidate as Record<string, unknown>;
                    const name = boundedDiagnosticText(service.name, 48);
                    return name
                        ? [name, service.enabled === true, Number.isSafeInteger(service.primaryStatus) ? service.primaryStatus : null]
                        : null;
                }).filter(Boolean)
                : undefined,
            disks: bootObservation && Number.isSafeInteger(bootObservation.hardDiskCount) ? bootObservation.hardDiskCount : undefined,
            dvds: bootObservation && Number.isSafeInteger(bootObservation.dvdCount) ? bootObservation.dvdCount : undefined,
            controllers: bootObservation && Array.isArray(bootObservation.hardDiskControllers)
                ? bootObservation.hardDiskControllers.filter((candidate: unknown) => ["ide", "scsi"].includes(String(candidate))).slice(0, 3)
                : undefined,
            boot: bootObservation && Array.isArray(bootObservation.bootDeviceTypes)
                ? bootObservation.bootDeviceTypes.filter((candidate: unknown) => ["hard-disk", "dvd", "network", "unknown"].includes(String(candidate))).slice(0, 3)
                : undefined,
        })
        : "";
    const boundedDetail = (candidate: unknown) => {
        if (typeof candidate !== "string" || candidate.length === 0) return "";
        const codes = candidate.match(/\b(?:appium|broker|hyper-v|powershell|ssh)-[a-z0-9-]{2,128}\b/g) || [];
        if (codes.length > 0) return [...new Set(codes)].slice(0, 4).join(",");
        return "";
    };
    const lifecycleFailure = boundedBrokerLifecycleFailure(value);
    const operation = boundedHyperVOperation(body?.operation) || boundedHyperVOperation(value?.operation)
        || lifecycleFailure?.operation;
    const native = nativeFailureNumbers(lifecycleFailure ?? body ?? value);
    const readiness = boundedDesktopReadiness(body?.readiness ?? value?.readiness);
    const validation = boundedValidationFailure(value);
    const tool = knownToolName(callName);
    const execution = boundedNativeExecution(providerExecution(value));
    const macosBoot = boundedMacosBoot(value);
    const processObservation = boundedProcessObservation(lastAttempt?.processVerification?.observation);
    const parts = [
        ...(validation ? [`validation=${validation.kind}`, `tool=${tool || validation.tool}`, `field=${validation.field}`]
            : tool ? [`tool=${tool}`] : []),
        boundedBrokerDiagnosticCode(value?.error),
        boundedBrokerDiagnosticCode(body?.error),
        ...(execution ? [`execution=${JSON.stringify(execution)}`] : []),
        ...(macosBoot ? [`macosBoot=${JSON.stringify(macosBoot)}`] : []),
        ...(processObservation ? [`observation=${JSON.stringify(processObservation)}`] : []),
        bootDiagnostic ? `boot=${bootDiagnostic}` : "",
        bootDiagnostic ? "" : boundedDetail(value?.detail),
        bootDiagnostic ? "" : boundedDetail(body?.detail),
        // What a failed allocation compensation was cleaning up after, which is the root cause.
        lifecycleFailure
            ? `lifecycle=${lifecycleFailure.error}${lifecycleFailure.detail ? `/${lifecycleFailure.detail}` : ""}`
            : "",
        operation ? `operation=${operation}` : "",
        native.nativeHResult !== undefined ? `hresult=0x${(native.nativeHResult >>> 0).toString(16).padStart(8, "0")}` : "",
        native.nativeErrorCategory !== undefined ? `category=${native.nativeErrorCategory}` : "",
        readiness ? `readiness=${JSON.stringify(readiness)}` : "",
        // Whether the failed create left anything behind, ahead of the bulkier diagnostics below.
        brokerRollbackSummary(value),
        diagnostic,
        transportRecovery,
        transportDiagnostic,
        brokerProcessDiagnostic,
    ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);
    const message = [...new Set(parts)].join(": ") || boundedDiagnosticText(fallback, 128) || "broker-operation-failed";
    return message.slice(0, 511);
}

export function parseContractToolPayload<K extends keyof DeviceLabToolOutputMap>(name: K, result: any, args: Record<string, any> = {}): DeviceLabToolOutputMap[K] {
    if (!hasDeviceLabOutputContract(name)) throw new Error(`No output contract registered for ${name}`);
    if (DEVICE_LAB_OUTPUT_CONTRACTS[name] === "image-content-v1") return validateDeviceLabToolOutput(name, result, args);
    if ((DEVICE_LAB_OUTPUT_CONTRACTS[name] === "action-v1" || name === "clipboard") && result?.isError !== true
        && result?.content?.length === 1 && result.content[0]?.type === "text" && result.content[0].text === "ok") {
        return validateDeviceLabToolOutput(name, "ok", args);
    }
    return validateDeviceLabToolOutput(name, parseToolPayload(result), args);
}

export function lifecycleDevice(payload: any, operation: string): DeviceRecord {
    const device = payload?.device || payload?.result?.device;
    if (device && typeof device === "object" && !Array.isArray(device) && typeof device.deviceId === "string" && device.deviceId) return device;
    throw new Error(`${operation} returned no device: ${JSON.stringify(payload)}`);
}

export function parseToolResult(result, options: any = {}) {
    const payload = jsonContentPayload(resultContent(result));
    const unexpectedSingleton = options.expectedErrorCode
        && (payload?.ok !== false || payload?.error !== options.expectedErrorCode);
    const expectedErrorCodes = options.expectedErrorCodes;
    const unexpectedSet = expectedErrorCodes !== undefined && (payload?.ok !== false
        || !Array.isArray(expectedErrorCodes)
        || !expectedErrorCodes.every(code => typeof code === "string" && code.length > 0)
        || !expectedErrorCodes.includes(payload?.error));
    if (unexpectedSingleton || unexpectedSet) {
        return parseToolPayload({ ...result, isError: true, __cccToolCallRecord: result?.__cccToolCallRecord });
    }
    if (options.expectedError === true && result?.isError === true && result.__cccToolCallRecord) {
        result.__cccToolCallRecord.expectedError = true;
    }
    if (payload) return payload;
    return JSON.parse(result?.content?.[0]?.text || "{}");
}

export function markExpectedToolError(result) {
    if (result?.isError === true && result.__cccToolCallRecord) {
        result.__cccToolCallRecord.expectedError = true;
    }
    return result;
}

export function markExpectedInputError(result, expectedCode: string) {
    const record = result?.__cccToolCallRecord;
    const payload = jsonContentPayload(resultContent(result));
    if (!record || result?.isError !== true || !expectedCode || payload?.error !== expectedCode) {
        throw new Error("Expected the exact MCP input rejection");
    }
    record.expectedError = true;
    record.expectedInputError = expectedCode;
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
