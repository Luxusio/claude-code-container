import { createHash } from "crypto";
import { spawn, spawnSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { TOOLS as DEVICE_LAB_MCP_TOOLS } from "../../device-lab-mcp/src/tools.mjs";
import { consumeDeviceLabMcpToolCalls, consumeDeviceLabMcpToolSessions } from "./device-lab-mcp-client.ts";
import { normalizeProviderConcurrency, partitionProviderFiles, runResourceAware } from "./provider-parallelism.ts";
import { aggregateStepResult } from "./result-status.ts";

let failed = false;
const counts = { PASS: 0, SKIP: 0, FAIL: 0 };
let strictSkipFailures = 0;
const records: any[] = [];
const toolCallRecords: any[] = [];
const toolSessionRecords: any[] = [];

function compactMessage(value, limit = 300) {
    const normalized = String(value || "unknown error").replace(/\s+/g, " ").trim() || "unknown error";
    return normalized.length > limit ? `${normalized.slice(0, limit - 3)}...` : normalized;
}

const hiddenCompatibilityTools = new Set([
    "device_broker_shutdown",
    "device_broker_rpc",
    "device_broker_lease",
    "device_broker_attach",
    "device_broker_apple",
    "device_broker_command",
    "device_broker_appium",
    "device_image_create",
    "device_image_clone",
]);
const hiddenLegacyTransportKeys = new Set([
    "broker",
    "viaBroker",
    "implicitBroker",
    "autolaunch",
    "hostCandidates",
    "launchHost",
    "port",
    "brokerPort",
    "timeoutMs",
    "rpcTimeoutMs",
    "launchTimeoutMs",
]);
const toolSchemasByName = new Map<string, any>(DEVICE_LAB_MCP_TOOLS.map((tool) => [tool.name, tool.inputSchema || {}]));

function canonicalToolSurface() {
    const tools = DEVICE_LAB_MCP_TOOLS.map((tool) => ({
        name: tool.name,
        inputSchema: tool.inputSchema || {},
    }));
    return {
        toolCount: tools.length,
        sha256: createHash("sha256").update(JSON.stringify(tools)).digest("hex"),
    };
}
const ARGUMENT_FACET_KEYS = [
    "action",
    "backend",
    "method",
    "direction",
    "button",
    "orientation",
    "provider",
    "physical",
    "packageName",
    "bundleId",
    "component",
    "snapshotName",
    "snapshotId",
    "permission",
    "service",
    "confirmDestructive",
    "force",
    "deleteAvd",
    "deleteSimulator",
    "eraseSimulator",
    "level",
    "status",
    "charging",
    "wifi",
    "data",
    "enabled",
];

function uniqueSorted(values: any[]): any[] {
    return [...new Set(values)].sort();
}

function toolArgumentFacets(tool, value) {
    if (!value || typeof value !== "object") return [];
    const facets = [];
    const collect = (itemValue) => {
        if (!itemValue || typeof itemValue !== "object") return;
        for (const key of ARGUMENT_FACET_KEYS) {
            const item = itemValue[key];
            if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
                facets.push(`${tool}:${key}=${String(item)}`);
            }
        }
    };
    collect(value);
    if ((tool === "device_run_flow" || tool === "mobile_run_flow") && Array.isArray(value.steps)) {
        for (const step of value.steps) collect(step?.arguments);
    }
    return uniqueSorted(facets);
}

function advertisedArgumentEnumFacets() {
    return uniqueSorted(DEVICE_LAB_MCP_TOOLS.flatMap((tool) => (Object.entries(tool.inputSchema?.properties || {}) as Array<[string, any]>)
        .filter(([key, schema]) => ARGUMENT_FACET_KEYS.includes(key) && Array.isArray(schema?.enum))
        .flatMap(([key, schema]) => schema.enum
            .filter((value) => typeof value === "string" || typeof value === "number" || typeof value === "boolean")
            .map((value) => `${tool.name}:${key}=${String(value)}`))));
}

function isProviderArgumentEnumFacet(facet) {
    return /:(?:backend|provider)=/.test(String(facet));
}

function argumentFacetParts(facet) {
    const match = /^([a-z][a-z0-9_]*):([A-Za-z][A-Za-z0-9_]*)=(.+)$/.exec(String(facet));
    if (!match) return null;
    return { tool: match[1], key: match[2], value: match[3] };
}

function schemaTypeMatches(type, value) {
    if (type === "array") return Array.isArray(value);
    if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
    if (type === "number") return typeof value === "number" && Number.isFinite(value);
    if (type === "string") return typeof value === "string";
    if (type === "boolean") return typeof value === "boolean";
    return true;
}

function validateSchemaValue(schema: any = {}, value: any, path = "arguments", options: any = {}) {
    const errors = [];
    if (schema.type && !schemaTypeMatches(schema.type, value)) {
        errors.push(`${path}:type=${schema.type}`);
        return errors;
    }
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) errors.push(`${path}:enum`);
    if (typeof schema.minimum === "number" && typeof value === "number" && value < schema.minimum) errors.push(`${path}:minimum=${schema.minimum}`);
    if (typeof schema.maximum === "number" && typeof value === "number" && value > schema.maximum) errors.push(`${path}:maximum=${schema.maximum}`);
    if (typeof schema.maxItems === "number" && Array.isArray(value) && value.length > schema.maxItems) errors.push(`${path}:maxItems=${schema.maxItems}`);
    if (Array.isArray(value) && schema.items) {
        value.forEach((item, index) => errors.push(...validateSchemaValue(schema.items, item, `${path}[${index}]`, options)));
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
        const properties = schema.properties || {};
        const propertyNames = Object.keys(properties);
        for (const key of Array.isArray(schema.required) ? schema.required : []) {
            if (!(key in value)) errors.push(`${path}.${key}:required`);
        }
        if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
            const matched = schema.anyOf.some((item) => (Array.isArray(item?.required) ? item.required : []).every((key) => key in value));
            if (!matched) errors.push(`${path}:anyOf`);
        }
        for (const key of Object.keys(value)) {
            if (key in properties) {
                errors.push(...validateSchemaValue(properties[key], value[key], `${path}.${key}`, options));
            } else if (propertyNames.length > 0 && !(options.allowHiddenTransportKeys && hiddenLegacyTransportKeys.has(key))) {
                errors.push(`${path}.${key}:unknown`);
            }
        }
    }
    return errors;
}

function validateToolArguments(tool, args) {
    if (hiddenCompatibilityTools.has(tool)) return [];
    const schema = toolSchemasByName.get(tool);
    if (!schema) return [`${tool}:unadvertised`];
    return validateSchemaValue(schema, args || {}, "arguments", { allowHiddenTransportKeys: true });
}

function flowStepArgumentSchemaFailures(flowTool, args) {
    if ((flowTool !== "device_run_flow" && flowTool !== "mobile_run_flow") || !Array.isArray(args?.steps)) return [];
    return args.steps.flatMap((step, index) => {
        const tool = String(step?.tool || step?.name || "");
        if (!tool) return [];
        const errors = validateToolArguments(tool, step?.arguments || {});
        return errors.length > 0 ? [{ index, tool, schemaErrors: errors, schemaErrorCount: errors.length }] : [];
    });
}

function matchingIndex(text, start, open, close) {
    let depth = 0;
    let quote = null;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
        const char = text[index];
        if (quote) {
            if (escaped) {
                escaped = false;
            } else if (char === "\\") {
                escaped = true;
            } else if (char === quote) {
                quote = null;
            }
            continue;
        }
        if (char === "\"" || char === "'" || char === "`") {
            quote = char;
            continue;
        }
        if (char === open) depth += 1;
        if (char === close) {
            depth -= 1;
            if (depth === 0) return index;
        }
    }
    return -1;
}

function objectLiteralAfterCallTool(text, callIndex) {
    const openParen = text.indexOf("(", callIndex);
    if (openParen < 0) return "";
    const closeParen = matchingIndex(text, openParen, "(", ")");
    if (closeParen < 0) return "";
    const argsText = text.slice(openParen + 1, closeParen);
    const comma = argsText.indexOf(",");
    if (comma < 0) return "";
    const objectStart = argsText.indexOf("{", comma);
    if (objectStart < 0) return "";
    const objectEnd = matchingIndex(argsText, objectStart, "{", "}");
    return objectEnd < 0 ? "" : argsText.slice(objectStart, objectEnd + 1);
}

function literalArgumentFacets(tool, objectText) {
    return ARGUMENT_FACET_KEYS.flatMap((key) => {
        const pattern = new RegExp(`(?:^|[,\\s])${key}\\s*:\\s*(?:(["'])(.*?)\\1|(-?\\d+(?:\\.\\d+)?)|\\b(true|false)\\b)`, "g");
        return [...objectText.matchAll(pattern)].map((match) => `${tool}:${key}=${match[2] ?? match[3] ?? match[4]}`);
    });
}

function reachableModuleFiles(entryFiles) {
    const reachable = new Set<string>();
    const visit = (file: string) => {
        const resolved = resolve(file);
        if (reachable.has(resolved) || !existsSync(resolved)) return;
        reachable.add(resolved);
        const text = readFileSync(resolved, "utf-8");
        for (const match of text.matchAll(/from\s+["']\.\/([^"']+\.ts)["']/g)) {
            visit(resolve(dirname(resolved), match[1]));
        }
    };
    for (const file of entryFiles) visit(file);
    return [...reachable].sort();
}

function scriptedToolRecords(entryFiles) {
    return reachableModuleFiles(entryFiles).flatMap((file) => {
        const text = readFileSync(file, "utf-8");
        return [...text.matchAll(/callTool\(\s*["']([a-z][a-z0-9_]+)["']/g)]
            .map((match) => {
                const tool = match[1];
                return {
                    file,
                    tool,
                    source: "callTool",
                    facets: literalArgumentFacets(tool, objectLiteralAfterCallTool(text, match.index || 0)),
                };
            });
    });
}

const args = process.argv.slice(2);
const compact = args.includes("--compact");
const failOnSkip = args.includes("--fail-on-skip") || process.env.CCC_REAL_DEVICE_LAB_FAIL_ON_SKIP === "1";
const failOnCoverageGap = args.includes("--fail-on-coverage-gap");
const jsonSummary = args.includes("--json-summary");
const jsonSummaryFileIndex = args.indexOf("--json-summary-file");
const jsonSummaryFile = jsonSummaryFileIndex >= 0 ? args[jsonSummaryFileIndex + 1] : "";
const jsonSummaryFileValueIndex = jsonSummaryFileIndex >= 0 ? jsonSummaryFileIndex + 1 : -1;
const providerConcurrencyIndex = args.indexOf("--provider-concurrency");
const providerConcurrencyValue = providerConcurrencyIndex >= 0 ? args[providerConcurrencyIndex + 1] : "";
const providerConcurrencyValueIndex = providerConcurrencyIndex >= 0 ? providerConcurrencyIndex + 1 : -1;
const providerConcurrency = normalizeProviderConcurrency(providerConcurrencyValue, 1);
const files = args.filter((arg, index) => (
    arg !== "--compact"
    && arg !== "--fail-on-skip"
    && arg !== "--fail-on-coverage-gap"
    && arg !== "--json-summary"
    && arg !== "--json-summary-file"
    && arg !== "--provider-concurrency"
    && index !== jsonSummaryFileValueIndex
    && index !== providerConcurrencyValueIndex
));
const scriptedRecords: any[] = scriptedToolRecords(files);

function recordStatus(status) {
    const normalized = status === "PASS" || status === "SKIP" || status === "FAIL" ? status : "FAIL";
    counts[normalized] += 1;
    if (normalized === "FAIL") failed = true;
    if (failOnSkip && normalized === "SKIP") {
        strictSkipFailures += 1;
        failed = true;
    }
    return normalized;
}

function skipCategory(record) {
    const reason = String(record?.reason || "");
    if (/missing (?:adb|emulator|xcrun|wsb|tart|vz|utmctl|xdotool|scrot)|no installed Android SDK system image|no physical (?:iOS|Android) device visible|missing CCC_REAL_|current display prerequisites/.test(reason)) return "provider-prerequisite";
    if (/not a (?:macOS|Windows|Linux) host/.test(reason)) return "host-platform";
    if (/hyper-v-management-permission/.test(reason)) return "host-permission";
    if (/\/dev\/kvm is not available/.test(reason)) return "host-virtualization";
    return "other";
}

function groupSkipsByCategory(items) {
    const grouped = new Map();
    for (const record of items.filter((item) => item?.status === "SKIP")) {
        const category = skipCategory(record);
        const current = grouped.get(category) || { category, count: 0, records: [] };
        current.count += 1;
        current.records.push({
            test: record.test,
            ...(record.step ? { step: record.step } : {}),
            ...(record.reason ? { reason: record.reason } : {}),
        });
        grouped.set(category, current);
    }
    return [...grouped.values()].sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
}

const providerGapSkipCategories = new Set(["provider-prerequisite", "host-platform", "host-permission", "host-virtualization"]);
const macosProviderValues = new Set(["auto", "tart", "vz", "utmctl"]);
const directOkExemptDiagnosticTools = new Set([
    "device_base_image_clone",
    "device_base_image_create",
    "device_snapshot_create",
    "device_snapshot_delete",
    "device_snapshot_restore",
    "device_wireless",
]);

function explainedProviderValuesFromSkips(skipCategories) {
    const explained = new Set();
    for (const item of skipCategories.filter((record) => providerGapSkipCategories.has(record?.category))) {
        const itemRecords = Array.isArray(item.records) ? item.records : [];
        const text = itemRecords.map((record) => `${record?.test || ""} ${record?.step || ""} ${record?.reason || ""}`).join("\n").toLowerCase();
        if (/android/.test(text) && /emulator/.test(text)) explained.add("backend=android-emulator");
        if (/android/.test(text) && /(?:physical|device|adb)/.test(text)) explained.add("backend=android-device");
        if (/ios/.test(text) && /simulator/.test(text)) explained.add("backend=ios-simulator");
        if (/ios/.test(text) && /(?:physical|device|xcrun|macos host)/.test(text)) explained.add("backend=ios-device");
        if (/windows sandbox|wsb/.test(text)) explained.add("backend=windows-sandbox");
        if (/hyper-v/.test(text) && /windows vm/.test(text)) explained.add("backend=windows-vm");
        if (/hyper-v/.test(text) && /linux vm/.test(text)) explained.add("backend=linux-vm");
        if (/macos|tart|vz|utmctl/.test(text)) explained.add("backend=macos-vm");
    }
    return explained;
}

function providerFacetIsExplained(facet, explainedProviderValues) {
    const match = /^([^:]+):(backend|provider)=(.+)$/.exec(String(facet));
    if (!match) return false;
    const [, , key, value] = match;
    if (key === "provider" && macosProviderValues.has(value)) return explainedProviderValues.has("backend=macos-vm");
    return explainedProviderValues.has(`${key}=${value}`);
}

async function executeModule(file: string) {
    let name = file;
    try {
        const mod = await import(pathToFileURL(file).href);
        name = mod.name || file;
        consumeDeviceLabMcpToolCalls();
        consumeDeviceLabMcpToolSessions();
        const result = await mod.run();
        return {
            ok: true,
            file,
            name,
            result,
            toolCalls: consumeDeviceLabMcpToolCalls(),
            toolSessions: consumeDeviceLabMcpToolSessions(),
        };
    } catch (error) {
        consumeDeviceLabMcpToolCalls();
        consumeDeviceLabMcpToolSessions();
        return {
            ok: false,
            file,
            name,
            error: { message: error?.message || String(error), stack: error?.stack },
        };
    }
}

const activeProviderChildren = new Set<any>();
const MAX_PROVIDER_WORKER_RESULT_BYTES = 16 * 1024 * 1024;

function terminateProviderChild(child, force = false) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === "win32" && Number.isInteger(child.pid)) {
        spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
            stdio: "ignore",
            windowsHide: true,
        });
        return;
    }
    try {
        if (Number.isInteger(child.pid)) {
            process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
        } else {
            child.kill(force ? "SIGKILL" : "SIGTERM");
        }
    } catch {
        // The worker group may have exited between observation and termination.
    }
}

function terminateActiveProviderChildren() {
    for (const child of activeProviderChildren) terminateProviderChild(child);
}

const providerSignalHandlers = new Map<NodeJS.Signals, () => void>();

function interruptProviderChildren(signal: "SIGINT" | "SIGTERM") {
    const children = [...activeProviderChildren];
    children.forEach((child) => terminateProviderChild(child));
    const forceTimer = setTimeout(() => {
        children.forEach((child) => terminateProviderChild(child, true));
    }, 2000);
    const exitTimer = setTimeout(() => {
        process.exit(signal === "SIGINT" ? 130 : 143);
    }, 5000);
    Promise.all(children.map((child) => (
        child.exitCode !== null || child.signalCode !== null
            ? Promise.resolve()
            : new Promise<void>((resolvePromise) => child.once("close", () => resolvePromise()))
    ))).finally(() => {
        clearTimeout(forceTimer);
        clearTimeout(exitTimer);
        process.exit(signal === "SIGINT" ? 130 : 143);
    });
}

function installProviderChildCleanup() {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
        const handler = () => interruptProviderChildren(signal);
        providerSignalHandlers.set(signal, handler);
        process.once(signal, handler);
    }
    process.once("exit", terminateActiveProviderChildren);
}

function uninstallProviderChildCleanup() {
    for (const [signal, handler] of providerSignalHandlers) {
        process.removeListener(signal, handler);
    }
    providerSignalHandlers.clear();
    process.removeListener("exit", terminateActiveProviderChildren);
}

async function executeProviderModule(file: string) {
    const worker = resolve(dirname(fileURLToPath(import.meta.url)), "provider-worker.ts");
    const watchdogScript = resolve(dirname(fileURLToPath(import.meta.url)), "process-tree-watchdog.ts");
    try {
        const output = await new Promise<string>((resolvePromise, rejectPromise) => {
            const child = spawn(process.execPath, [worker, file], {
                cwd: process.cwd(),
                env: process.env,
                stdio: ["ignore", "inherit", "inherit", "pipe"],
                windowsHide: true,
                detached: process.platform !== "win32",
            });
            activeProviderChildren.add(child);
            const watchdog = Number.isInteger(child.pid)
                ? spawn(process.execPath, [watchdogScript, String(child.pid), String(process.pid)], {
                    cwd: process.cwd(),
                    env: process.env,
                    stdio: ["pipe", "ignore", "ignore"],
                    windowsHide: true,
                    detached: true,
                })
                : null;
            watchdog?.unref();
            (watchdog?.stdin as any)?.unref?.();
            const chunks: Buffer[] = [];
            let outputBytes = 0;
            let outputLimitExceeded = false;
            child.stdio[3]?.on("data", (chunk) => {
                const buffer = Buffer.from(chunk);
                outputBytes += buffer.length;
                if (outputBytes > MAX_PROVIDER_WORKER_RESULT_BYTES) {
                    outputLimitExceeded = true;
                    terminateProviderChild(child, true);
                    return;
                }
                chunks.push(buffer);
            });
            child.once("error", (error) => {
                activeProviderChildren.delete(child);
                watchdog?.stdin?.end("complete");
                rejectPromise(error);
            });
            child.once("close", () => {
                activeProviderChildren.delete(child);
                watchdog?.stdin?.end("complete");
                if (outputLimitExceeded) {
                    rejectPromise(new Error(`provider worker result exceeded ${MAX_PROVIDER_WORKER_RESULT_BYTES} bytes`));
                    return;
                }
                resolvePromise(Buffer.concat(chunks).toString("utf-8"));
            });
        });
        if (!output) {
            return {
                ok: false,
                file,
                name: file,
                error: { message: "provider worker exited without a result" },
            };
        }
        const parsed = JSON.parse(output);
        if (!parsed || typeof parsed !== "object" || parsed.file !== file || typeof parsed.ok !== "boolean") {
            throw new Error("provider worker returned an invalid result envelope");
        }
        return parsed;
    } catch (error) {
        return {
            ok: false,
            file,
            name: file,
            error: { message: error?.message || String(error), stack: error?.stack },
        };
    }
}

function collectExecution(execution) {
    const file = execution.file;
    const currentTestName = execution.name || file;
    try {
        if (!execution.ok) throw Object.assign(new Error(execution.error?.message || "provider worker failed"), execution.error || {});
        const result = execution.result;
        const moduleToolCalls = Array.isArray(execution.toolCalls) ? execution.toolCalls : [];
        const moduleToolSessions = Array.isArray(execution.toolSessions) ? execution.toolSessions : [];
        const moduleName = execution.name || file;
        const explicitTools = Array.isArray(result?.tools) ? result.tools.map(String) : [];
        const explicitScriptedTools = Array.isArray(result?.scriptedTools) ? result.scriptedTools.map(String) : [];
        const explicitScriptedArgumentFacets = Array.isArray(result?.scriptedArgumentFacets) ? result.scriptedArgumentFacets.map(String) : [];
        const moduleTools = uniqueSorted([...moduleToolCalls.map((call) => call.name).filter(Boolean), ...explicitTools]);
        for (const call of moduleToolCalls) {
            const schemaErrors = validateToolArguments(call.name, call.arguments);
            const flowSchemaFailures = flowStepArgumentSchemaFailures(call.name, call.arguments);
            toolCallRecords.push({
                file,
                test: moduleName,
                tool: call.name,
                ...(call.mcpSessionId ? { mcpSessionId: call.mcpSessionId } : {}),
                schemaValid: schemaErrors.length === 0,
                schemaErrorCount: schemaErrors.length,
                ...(schemaErrors.length > 0 ? { schemaErrors } : {}),
                ...(flowSchemaFailures.length > 0 ? { flowStepArgumentSchemaFailures: flowSchemaFailures } : {}),
                outcome: call.outcome || "unknown",
                ...(typeof call.isError === "boolean" ? { isError: call.isError } : {}),
                ...(call.expectedError === true ? { expectedError: true } : {}),
                ...(typeof call.errorPayloadText === "boolean" ? { errorPayloadText: call.errorPayloadText } : {}),
                ...(typeof call.errorDispatchMismatch === "boolean" ? { errorDispatchMismatch: call.errorDispatchMismatch } : {}),
                ...(typeof call.errorPayloadJson === "boolean" ? { errorPayloadJson: call.errorPayloadJson } : {}),
                ...(call.errorCode ? { errorCode: call.errorCode } : {}),
                ...(Array.isArray(call.contentTypes) ? { contentTypes: call.contentTypes } : {}),
                ...(typeof call.okPayloadText === "boolean" ? { okPayloadText: call.okPayloadText } : {}),
                ...(typeof call.okPayloadJson === "boolean" ? { okPayloadJson: call.okPayloadJson } : {}),
                ...(typeof call.okPayloadImage === "boolean" ? { okPayloadImage: call.okPayloadImage } : {}),
                ...(call.okPayloadShape ? { okPayloadShape: call.okPayloadShape } : {}),
                ...(call.error ? { error: call.error } : {}),
                ...(Array.isArray(call.flowSteps) ? { flowSteps: call.flowSteps } : {}),
                facets: toolArgumentFacets(call.name, call.arguments),
            });
        }
        for (const session of moduleToolSessions) {
            toolSessionRecords.push({
                file,
                test: moduleName,
                id: session.id || "",
                name: session.name || "unknown",
                serverPath: session.serverPath || "",
                serverSource: session.serverSource || "unknown",
                serverFile: session.serverFile || null,
                advertisedToolSurface: session.advertisedToolSurface || null,
                node: session.node || "",
                envOverrides: Array.isArray(session.envOverrides) ? session.envOverrides : [],
            });
        }
        for (const tool of explicitScriptedTools) {
            scriptedRecords.push({ file, test: moduleName, tool, source: "declared-scripted-result" });
        }
        for (const facet of explicitScriptedArgumentFacets) {
            const tool = facet.split(":")[0];
            if (tool) scriptedRecords.push({ file, test: moduleName, tool, source: "declared-scripted-argument-facet", facets: [facet] });
        }
        const status = result?.status;
        const reason = result?.reason ? ` - ${compact ? compactMessage(result.reason) : result.reason}` : "";
        const detail = result?.detail ? ` (${result.detail})` : "";
        if (Array.isArray(result?.steps)) {
            const parentStatusValid = status === "PASS" || status === "SKIP" || status === "FAIL";
            const childStatusesValid = result.steps.length > 0 && result.steps.every((step) => step?.status === "PASS" || step?.status === "SKIP" || step?.status === "FAIL");
            const childAggregate = aggregateStepResult(result.steps);
            const consistencyReason = !parentStatusValid
                ? `invalid or missing parent result status: ${JSON.stringify(status)}`
                : result.steps.length === 0
                    ? "result returned an empty step list"
                    : childStatusesValid && childAggregate.status !== status
                        ? `parent result status ${status} disagrees with child aggregate ${childAggregate.status}`
                        : "";
            if (consistencyReason) {
                recordStatus("FAIL");
                records.push({
                    file,
                    test: moduleName,
                    step: "validates parent result status",
                    status: "FAIL",
                    reason: consistencyReason,
                });
                console.log(`FAIL ${moduleName}: validates parent result status - ${compact ? compactMessage(consistencyReason) : consistencyReason}`);
            }
            for (const step of result.steps) {
                const invalidStatusReason = step?.status === "PASS" || step?.status === "SKIP" || step?.status === "FAIL"
                    ? ""
                    : `invalid or missing step status: ${JSON.stringify(step?.status)}`;
                const effectiveReason = step?.reason || invalidStatusReason;
                const stepStatus = recordStatus(step?.status);
                const stepReason = effectiveReason ? ` - ${compact ? compactMessage(effectiveReason) : effectiveReason}` : "";
                const stepDetail = step?.detail ? ` (${step.detail})` : "";
                records.push({
                    file,
                    test: moduleName,
                    step: step?.name || "unnamed step",
                    status: stepStatus,
                    ...(effectiveReason ? { reason: effectiveReason } : {}),
                    ...(step?.detail ? { detail: step.detail } : {}),
                    ...(Array.isArray(step?.tools) ? { tools: uniqueSorted(step.tools) } : {}),
                });
                if (!compact || stepStatus === "FAIL" || (failOnSkip && stepStatus === "SKIP")) {
                    console.log(`${stepStatus} ${moduleName}: ${step?.name || "unnamed step"}${stepReason}${stepDetail}`);
                }
            }
        } else {
            const invalidStatusReason = status === "PASS" || status === "SKIP" || status === "FAIL"
                ? ""
                : `invalid or missing result status: ${JSON.stringify(status)}`;
            const effectiveReason = result?.reason || invalidStatusReason;
            const normalizedStatus = recordStatus(status);
            records.push({
                file,
                test: moduleName,
                status: normalizedStatus,
                ...(effectiveReason ? { reason: effectiveReason } : {}),
                ...(result?.detail ? { detail: result.detail } : {}),
                ...(moduleTools.length > 0 ? { tools: moduleTools } : {}),
            });
            if (!compact || normalizedStatus === "FAIL" || (failOnSkip && normalizedStatus === "SKIP")) {
                const effectiveReasonText = effectiveReason ? ` - ${compact ? compactMessage(effectiveReason) : effectiveReason}` : reason;
                console.log(`${normalizedStatus} ${moduleName}${effectiveReasonText}${detail}`);
            }
        }
    } catch (error) {
        recordStatus("FAIL");
        records.push({
            file,
            test: currentTestName,
            status: "FAIL",
            reason: error?.message || String(error),
        });
        console.error(`FAIL ${currentTestName} - ${compact ? compactMessage(error?.message || error) : (error?.stack || error?.message || String(error))}`);
    }
}

const { serial: serialFiles, providers: providerFiles } = partitionProviderFiles(files);
for (const file of serialFiles) {
    collectExecution(await executeModule(file));
}

if (providerFiles.length > 0) {
    if (providerConcurrency > 1) {
        console.log(`PROVIDERS concurrency=${providerConcurrency} count=${providerFiles.length}`);
    }
    installProviderChildCleanup();
    try {
        const executions = await runResourceAware(
            providerFiles,
            providerConcurrency,
            executeProviderModule,
        );
        executions.forEach(collectExecution);
    } finally {
        uninstallProviderChildCleanup();
    }
}

const total = counts.PASS + counts.SKIP + counts.FAIL;
const strictSummary = failOnSkip ? ` strictSkipFailures=${strictSkipFailures}` : "";
const activeScriptFiles = new Set(records
    .filter((record) => record?.status !== "SKIP" && record?.file)
    .map((record) => resolve(record.file)));
const effectiveScriptedRecords = scriptedRecords.filter((record) => !record.file || activeScriptFiles.has(resolve(record.file)));
const advertisedTools = uniqueSorted(DEVICE_LAB_MCP_TOOLS.map((tool) => tool.name));
const calledTools = uniqueSorted(toolCallRecords.map((record) => record.tool));
const calledPublicTools = calledTools.filter((tool) => advertisedTools.includes(tool));
const calledHiddenCompatibilityTools = calledTools.filter((tool) => hiddenCompatibilityTools.has(tool));
const calledArgumentFacets = uniqueSorted(toolCallRecords.flatMap((record) => Array.isArray(record.facets) ? record.facets : []));
const advertisedArgumentEnumFacetsList = advertisedArgumentEnumFacets();
const calledAdvertisedArgumentEnumFacets = calledArgumentFacets.filter((facet) => advertisedArgumentEnumFacetsList.includes(facet));
const uncalledAdvertisedArgumentEnumFacets = advertisedArgumentEnumFacetsList.filter((facet) => !calledArgumentFacets.includes(facet));
const uncalledProviderArgumentEnumFacets = uncalledAdvertisedArgumentEnumFacets.filter(isProviderArgumentEnumFacet);
const uncalledNonProviderArgumentEnumFacets = uncalledAdvertisedArgumentEnumFacets.filter((facet) => !isProviderArgumentEnumFacet(facet));
const callOutcomes = Object.fromEntries([...new Set(toolCallRecords.map((record) => record.outcome || "unknown"))]
    .sort()
    .map((outcome) => [outcome, toolCallRecords.filter((record) => (record.outcome || "unknown") === outcome).length]));
const scriptedTools = uniqueSorted(effectiveScriptedRecords.map((record) => record.tool));
const scriptedPublicTools = scriptedTools.filter((tool) => advertisedTools.includes(tool));
const scriptedHiddenCompatibilityTools = scriptedTools.filter((tool) => hiddenCompatibilityTools.has(tool));
const scriptedArgumentFacets = uniqueSorted(effectiveScriptedRecords.flatMap((record) => Array.isArray(record.facets) ? record.facets : []));
const invalidScriptedArgumentFacets = scriptedArgumentFacets.filter((facet) => {
    const parts = argumentFacetParts(facet);
    if (!parts) return true;
    if (!ARGUMENT_FACET_KEYS.includes(parts.key)) return true;
    return !advertisedTools.includes(parts.tool) && !hiddenCompatibilityTools.has(parts.tool);
});
const uncalledAdvertisedTools = advertisedTools.filter((tool) => !calledPublicTools.includes(tool));
const unscriptedAdvertisedTools = advertisedTools.filter((tool) => !scriptedPublicTools.includes(tool));
const uncalledScriptedTools = scriptedTools.filter((tool) => !calledTools.includes(tool));
const uncalledScriptedArgumentFacets = scriptedArgumentFacets.filter((facet) => !calledArgumentFacets.includes(facet));
const unadvertisedTools = calledTools.filter((tool) => !advertisedTools.includes(tool) && !hiddenCompatibilityTools.has(tool));
const incompleteOutcomeRecords = toolCallRecords.filter((record) => ["pending", "unknown", "thrown"].includes(record.outcome || "unknown"));
const argumentSchemaFailureRecords = toolCallRecords.filter((record) => record.schemaValid === false);
const flowStepArgumentSchemaFailureRecords = toolCallRecords.flatMap((record) => (Array.isArray(record.flowStepArgumentSchemaFailures) ? record.flowStepArgumentSchemaFailures : []).map((failure) => ({
    file: record.file,
    test: record.test,
    flowTool: record.tool,
    ...failure,
})));
const unexpectedErrorResultRecords = toolCallRecords.filter((record) => record.outcome === "error-result" && record.expectedError !== true);
const expectedErrorResultRecords = toolCallRecords.filter((record) => record.outcome === "error-result" && record.expectedError === true);
const expectedErrorPayloadFailures = expectedErrorResultRecords.filter((record) => {
    if (record.errorPayloadJson === true) return !record.errorCode;
    return record.errorPayloadText !== true || record.errorDispatchMismatch === true;
});
const okPublicPayloadFailures = toolCallRecords.filter((record) => (
    record.outcome === "ok"
    && advertisedTools.includes(record.tool)
    && record.okPayloadJson !== true
    && record.okPayloadImage !== true
));
function emptyPayloadShape(shape) {
    if (shape?.kind === "object") return !Array.isArray(shape.keys) || shape.keys.length === 0;
    if (shape?.kind === "array") return !Number.isInteger(shape.itemCount) || shape.itemCount === 0;
    return false;
}
const emptyOkPublicPayloadRecords = toolCallRecords.filter((record) => (
    record.outcome === "ok"
    && advertisedTools.includes(record.tool)
    && record.okPayloadJson === true
    && emptyPayloadShape(record.okPayloadShape)
));
const flowStepRecords = toolCallRecords.flatMap((record) => (Array.isArray(record.flowSteps) ? record.flowSteps : []).map((step, index) => ({
    file: record.file,
    test: record.test,
    flowTool: record.tool,
    index,
    tool: step.tool,
    isError: step.isError === true,
    expectedError: step.expectedError === true,
    ...(Array.isArray(step.contentTypes) ? { contentTypes: step.contentTypes } : {}),
    ...(typeof step.okPayloadJson === "boolean" ? { okPayloadJson: step.okPayloadJson } : {}),
    ...(typeof step.okPayloadImage === "boolean" ? { okPayloadImage: step.okPayloadImage } : {}),
    ...(step.okPayloadShape ? { okPayloadShape: step.okPayloadShape } : {}),
    ...(typeof step.errorPayloadJson === "boolean" ? { errorPayloadJson: step.errorPayloadJson } : {}),
    ...(step.errorCode ? { errorCode: step.errorCode } : {}),
})));
const flowStepOutcomeSummary = Object.fromEntries(uniqueSorted(flowStepRecords.map((record) => record.tool)).map((tool) => {
    const toolRecords = flowStepRecords.filter((record) => record.tool === tool);
    return [tool, {
        total: toolRecords.length,
        ok: toolRecords.filter((record) => record.isError !== true).length,
        error: toolRecords.filter((record) => record.isError === true).length,
    }];
}));
const expectedFlowStepErrorRecords = flowStepRecords.filter((record) => record.isError === true && record.expectedError === true);
const unexpectedFlowStepErrorRecords = flowStepRecords.filter((record) => record.isError === true && record.expectedError !== true);
const expectedFlowStepPayloadFailures = expectedFlowStepErrorRecords.filter((record) => record.errorPayloadJson !== true || !record.errorCode);
const okPublicFlowStepPayloadFailures = flowStepRecords.filter((record) => (
    record.isError !== true
    && advertisedTools.includes(record.tool)
    && record.okPayloadJson !== true
    && record.okPayloadImage !== true
));
const emptyOkPublicFlowStepPayloadRecords = flowStepRecords.filter((record) => (
    record.isError !== true
    && advertisedTools.includes(record.tool)
    && record.okPayloadJson === true
    && emptyPayloadShape(record.okPayloadShape)
));
const flowStepToolOutcomeSummary: Record<string, any> = Object.fromEntries(uniqueSorted(flowStepRecords.map((record) => record.tool)).map((tool) => {
    const toolRecords = flowStepRecords.filter((record) => record.tool === tool);
    return [tool, {
        total: toolRecords.length,
        ok: toolRecords.filter((record) => record.isError !== true).length,
        expectedError: toolRecords.filter((record) => record.isError === true && record.expectedError === true).length,
        unexpectedError: toolRecords.filter((record) => record.isError === true && record.expectedError !== true).length,
    }];
}));
const toolOutcomeSummary: Record<string, any> = Object.fromEntries(calledTools.map((tool) => {
    const toolRecords = toolCallRecords.filter((record) => record.tool === tool);
    const count = (predicate) => toolRecords.filter(predicate).length;
    return [tool, {
        total: toolRecords.length,
        ok: count((record) => ["ok", "declared"].includes(record.outcome || "unknown")),
        expectedError: count((record) => record.outcome === "error-result" && record.expectedError === true),
        unexpectedError: count((record) => record.outcome === "error-result" && record.expectedError !== true),
        incomplete: count((record) => ["pending", "unknown", "thrown"].includes(record.outcome || "unknown")),
    }];
}));
const publicToolsWithoutOkOrExpectedError = calledPublicTools.filter((tool) => {
    const outcome = toolOutcomeSummary[tool];
    return !outcome || (outcome.ok === 0 && outcome.expectedError === 0);
});
const publicFlowStepTools = uniqueSorted(flowStepRecords.map((record) => record.tool).filter((tool) => advertisedTools.includes(tool)));
const publicFlowStepToolsWithoutOkOrExpectedError = publicFlowStepTools.filter((tool) => {
    const outcome = flowStepToolOutcomeSummary[tool];
    return !outcome || (outcome.ok === 0 && outcome.expectedError === 0);
});
const toolEvidenceSummary: Record<string, any> = Object.fromEntries(advertisedTools.map((tool) => {
    const direct = toolOutcomeSummary[tool] || { total: 0, ok: 0, expectedError: 0, unexpectedError: 0, incomplete: 0 };
    const flow = flowStepToolOutcomeSummary[tool] || { total: 0, ok: 0, expectedError: 0, unexpectedError: 0 };
    const evidence = [];
    if (direct.ok > 0) evidence.push("direct-ok");
    if (direct.expectedError > 0) evidence.push("direct-expected-error");
    if (flow.ok > 0) evidence.push("flow-ok");
    if (flow.expectedError > 0) evidence.push("flow-expected-error");
    return [tool, { direct, flow, evidence }];
}));
const publicToolsWithoutEvidence = calledPublicTools.filter((tool) => toolEvidenceSummary[tool].evidence.length === 0);
const publicToolsWithoutDirectOk = calledPublicTools.filter((tool) => toolEvidenceSummary[tool].direct.ok === 0);
const publicToolsWithOnlyExpectedErrorEvidence = calledPublicTools.filter((tool) => {
    const summary = toolEvidenceSummary[tool];
    return summary.evidence.length > 0 && summary.direct.ok === 0 && summary.flow.ok === 0;
});
const skipCategories = groupSkipsByCategory(records);
const explainedProviderValues = explainedProviderValuesFromSkips(skipCategories);
const unexplainedProviderArgumentEnumFacets = uncalledProviderArgumentEnumFacets.filter((facet) => !providerFacetIsExplained(facet, explainedProviderValues));
const diagnosticOnlyTools = new Set(publicToolsWithOnlyExpectedErrorEvidence);
const diagnosticOnlyToolIsExplained = (tool) => {
    const toolProviderFacets = calledAdvertisedArgumentEnumFacets
        .filter((facet) => String(facet).startsWith(`${tool}:`))
        .filter((facet) => /:(?:backend|provider)=/.test(String(facet)));
    return toolProviderFacets.length > 0 && toolProviderFacets.some((facet) => providerFacetIsExplained(facet, explainedProviderValues));
};
const unexplainedDiagnosticOnlyTools = [...diagnosticOnlyTools].filter((tool) => !diagnosticOnlyToolIsExplained(tool));
const unjustifiedMissingDirectOkTools = publicToolsWithoutDirectOk.filter((tool) => (
    !directOkExemptDiagnosticTools.has(tool) || !diagnosticOnlyTools.has(tool) || !diagnosticOnlyToolIsExplained(tool)
));
const strictCoverageFailures = failOnCoverageGap
    ? unscriptedAdvertisedTools.length + uncalledScriptedTools.length + uncalledScriptedArgumentFacets.length + invalidScriptedArgumentFacets.length + unadvertisedTools.length + publicToolsWithoutEvidence.length
    : 0;
const strictOutcomeFailures = failOnCoverageGap
    ? incompleteOutcomeRecords.length + argumentSchemaFailureRecords.length + flowStepArgumentSchemaFailureRecords.length + unexpectedErrorResultRecords.length + expectedErrorPayloadFailures.length + okPublicPayloadFailures.length + emptyOkPublicPayloadRecords.length + publicFlowStepToolsWithoutOkOrExpectedError.length + expectedFlowStepPayloadFailures.length + okPublicFlowStepPayloadFailures.length + emptyOkPublicFlowStepPayloadRecords.length
    : 0;
if (strictCoverageFailures > 0 || strictOutcomeFailures > 0) failed = true;
const summaryPayload = {
    host: {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
    },
    total,
    pass: counts.PASS,
    skip: counts.SKIP,
    fail: counts.FAIL,
    failOnSkip,
    failOnCoverageGap,
    ...(failOnSkip ? { strictSkipFailures } : {}),
    ...(failOnCoverageGap ? { strictCoverageFailures } : {}),
    ...(failOnCoverageGap ? { strictOutcomeFailures } : {}),
    skipCategories,
    toolCoverage: {
        canonicalToolSurface: canonicalToolSurface(),
        advertisedTools,
        calledTools,
        calledPublicTools,
        calledHiddenCompatibilityTools,
        calledArgumentFacets,
        advertisedArgumentEnumFacets: advertisedArgumentEnumFacetsList,
        calledAdvertisedArgumentEnumFacets,
        uncalledAdvertisedArgumentEnumFacets,
        uncalledProviderArgumentEnumFacets,
        uncalledNonProviderArgumentEnumFacets,
        explainedProviderValues: [...explainedProviderValues].sort(),
        unexplainedProviderArgumentEnumFacets,
        callOutcomes,
        toolOutcomeSummary,
        toolEvidenceSummary,
        publicToolsWithoutOkOrExpectedError,
        publicToolsWithoutEvidence,
        publicToolsWithoutDirectOk,
        publicToolsWithOnlyExpectedErrorEvidence,
        unexplainedDiagnosticOnlyTools,
        unjustifiedMissingDirectOkTools,
        scriptedTools,
        scriptedPublicTools,
        scriptedHiddenCompatibilityTools,
        scriptedArgumentFacets,
        invalidScriptedArgumentFacets,
        uncalledAdvertisedTools,
        unscriptedAdvertisedTools,
        uncalledScriptedTools,
        uncalledScriptedArgumentFacets,
        unadvertisedTools,
        incompleteOutcomeRecords,
        argumentSchemaFailureRecords,
        flowStepArgumentSchemaFailures: flowStepArgumentSchemaFailureRecords,
        unexpectedErrorResultRecords,
        expectedErrorResultRecords,
        expectedErrorPayloadFailures,
        okPublicPayloadFailures,
        emptyOkPublicPayloadRecords,
        flowStepOutcomeSummary,
        flowStepToolOutcomeSummary,
        publicFlowStepTools,
        publicFlowStepToolsWithoutOkOrExpectedError,
        expectedFlowStepErrorRecords,
        unexpectedFlowStepErrorRecords,
        expectedFlowStepPayloadFailures,
        okPublicFlowStepPayloadFailures,
        emptyOkPublicFlowStepPayloadRecords,
        calls: toolCallRecords,
        scripted: effectiveScriptedRecords,
    },
    mcpSessions: toolSessionRecords,
    records,
};
const strictCoverageSummary = failOnCoverageGap ? ` strictCoverageFailures=${strictCoverageFailures}` : "";
const strictOutcomeSummary = failOnCoverageGap ? ` strictOutcomeFailures=${strictOutcomeFailures}` : "";
if (compact && skipCategories.length > 0) {
    console.log(`SKIPS ${skipCategories.map((item) => `${item.category}=${item.count}`).join(" ")}`);
}
console.log(`SUMMARY real-tests total=${total} pass=${counts.PASS} skip=${counts.SKIP} fail=${counts.FAIL} failOnSkip=${failOnSkip}${strictSummary}${strictCoverageSummary}${strictOutcomeSummary}`);
if (jsonSummary) {
    console.log(`JSON_SUMMARY ${JSON.stringify(summaryPayload)}`);
}
if (jsonSummaryFile) {
    mkdirSync(dirname(jsonSummaryFile), { recursive: true });
    writeFileSync(jsonSummaryFile, `${JSON.stringify(summaryPayload, null, 2)}\n`);
}
process.exit(failed ? 1 : 0);
