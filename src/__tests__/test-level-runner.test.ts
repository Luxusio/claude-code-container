import Ajv from "ajv";
import { toolInputError } from "../../device-lab-mcp/src/tool-arguments.mjs";
import { backendProviderEnumDiagnostics, missingWindowsImageProbe, probeMissingMacosImage } from "../../scripts/real-tests/level2-broker-e2e.ts";
import { spawn, spawnSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, dirname, join } from "path";
import { pathToFileURL } from "url";
import { parse } from "acorn";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { describe, expect, it } from "vitest";
import { DESTRUCTIVE_POLICY_SCHEMA_EXAMPLES, evaluateDestructivePolicy } from "../../device-lab-mcp/src/policy/destructive.mjs";
import { DEVICE_FLOW_TOOL_NAMES, TOOLS, publicToolName, toolOperation, GROUP_OPERATIONS, CREATE_TOOL_BACKENDS } from "../../device-lab-mcp/src/tools.mjs";
import { LINUX_VM_CAPABILITIES } from "@ccc/device-lab/providers/backends/linux-vm.mjs";
import { androidDeviceE2EPrerequisites, prepareAndroidDeviceApp } from "../../scripts/real-tests/android-device-e2e.ts";
import { androidEmulatorAppSelection, androidEmulatorCreateRequest, deviceFromPayload } from "../../scripts/real-tests/android-emulator-e2e.ts";
import { currentDisplayPrerequisiteResult } from "../../scripts/real-tests/level1-display-e2e.ts";
import { startWindowsSandboxE2EDevice } from "../../scripts/real-tests/windows-sandbox-e2e.ts";
import { realMcpToolRequestTimeoutMs } from "../../scripts/real-tests/device-lab-mcp-client.ts";
import { brokerDeviceToolExecutionTimeout } from "../../device-lab-mcp/src/domain/device-request.mjs";
import {
    normalizeProviderConcurrency,
    partitionProviderFiles,
    runResourceAware,
} from "../../scripts/real-tests/provider-parallelism.ts";
import { repoRoot } from "./helpers/device-lab-mcp-fixture.js";

const runner = join(repoRoot, "scripts", "test-level.js");
const repoLoader = pathToFileURL(join(repoRoot, "scripts", "real-tests", "typescript-source-loader.mjs")).href;

function parseModule(text: string) {
    const javascript = transpileModule(text, {
        compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2023 },
    }).outputText;
    return parse(javascript, { ecmaVersion: "latest", sourceType: "module" });
}
const HIDDEN_LEGACY_TRANSPORT_KEYS = new Set([
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
const HIDDEN_PROVIDER_REAL_E2E_TRANSPORT_KEYS = new Set(
    [...HIDDEN_LEGACY_TRANSPORT_KEYS].filter((key) => key !== "port" && key !== "timeoutMs"),
);
const OPT_IN_REAL_TEST_UTILITY_FILES = new Set([
    "installed-mcp-smoke.ts",
]);

function dryRun(level: string) {
    const result = spawnSync(process.execPath, [runner, level, "--dry-run"], {
        cwd: repoRoot,
        encoding: "utf-8",
    });
    expect(result.status).toBe(0);
    return JSON.parse(result.stdout) as { level: number; args: string[]; env: Record<string, string> };
}

function dryRunNode(level: string) {
    const result = spawnSync(process.execPath, [runner, level, "--dry-run", "--node-test"], {
        cwd: repoRoot,
        encoding: "utf-8",
    });
    expect(result.status).toBe(0);
    return JSON.parse(result.stdout) as { level: number; mode: string; args: string[]; env: Record<string, string> };
}

function mcpTextResult(payload: unknown, isError = false) {
    return { isError, content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload) }] };
}

function advertisedDeviceLabTools() {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", "import { TOOLS } from './device-lab-mcp/src/tools.mjs'; console.log(JSON.stringify(TOOLS.map((tool) => tool.name)));"], {
        cwd: repoRoot,
        encoding: "utf-8",
    });
    expect(result.status).toBe(0);
    return JSON.parse(result.stdout) as string[];
}

function canonicalDeviceLabToolSurface() {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", [
        "import { createHash } from 'crypto';",
        "import { TOOLS } from './device-lab-mcp/src/tools.mjs';",
        "const tools = TOOLS.map((tool) => ({ name: tool.name, inputSchema: tool.inputSchema || {} }));",
        "console.log(JSON.stringify({ toolCount: tools.length, sha256: createHash('sha256').update(JSON.stringify(tools)).digest('hex') }));",
    ].join("")], {
        cwd: repoRoot,
        encoding: "utf-8",
    });
    expect(result.status).toBe(0);
    return JSON.parse(result.stdout) as { toolCount: number; sha256: string };
}

function schemaBranches(schema: any): any[] {
    return [schema, ...[...(schema?.oneOf || []), ...(schema?.anyOf || []), ...(schema?.allOf || [])].flatMap(schemaBranches)];
}

function advertisedDeviceLabToolSchemas() {
    return new Map(TOOLS.map(tool => [tool.name, new Set(schemaBranches(tool.inputSchema).flatMap(branch => Object.keys(branch.properties || {})))]));
}

function advertisedDeviceLabToolAnyOfRequired() {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", "import { TOOLS } from './device-lab-mcp/src/tools.mjs'; console.log(JSON.stringify(TOOLS.map((tool) => [tool.name, (tool.inputSchema?.anyOf || []).map((item) => item.required || [])])));"], {
        cwd: repoRoot,
        encoding: "utf-8",
    });
    expect(result.status).toBe(0);
    return new Map(JSON.parse(result.stdout) as Array<[string, string[][]]>);
}

function advertisedDeviceLabToolEnums() {
    return new Map(TOOLS.map(tool => {
        const enums: Record<string, string[]> = {};
        for (const branch of schemaBranches(tool.inputSchema)) {
            for (const [key, value] of Object.entries(branch.properties || {}) as Array<[string, any]>) {
                if (Array.isArray(value.enum)) enums[key] = [...new Set([...(enums[key] || []), ...value.enum])];
            }
        }
        return [tool.name, enums];
    }));
}

function astChildren(node: unknown): unknown[] {
    if (!node || typeof node !== "object") return [];
    const children: unknown[] = [];
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === "parent" || key === "loc" || key === "range" || key === "start" || key === "end") continue;
        if (Array.isArray(value)) {
            for (const item of value) {
                if (item && typeof item === "object" && typeof (item as { type?: unknown }).type === "string") children.push(item);
            }
        } else if (value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string") {
            children.push(value);
        }
    }
    return children;
}

function walkAst(node: unknown, visit: (node: Record<string, unknown>) => void) {
    if (!node || typeof node !== "object") return;
    visit(node as Record<string, unknown>);
    for (const child of astChildren(node)) walkAst(child, visit);
}

function propertyKey(property: Record<string, unknown>) {
    if (property.type !== "Property") return null;
    const key = property.key as Record<string, unknown> | undefined;
    if (!key) return null;
    if (key.type === "Identifier") return String(key.name);
    if (key.type === "Literal" && (typeof key.value === "string" || typeof key.value === "number")) return String(key.value);
    return null;
}

// Accept `{...}` and `Object.freeze({...})`; real E2E scripts freeze shared option sets.
function frozenObjectExpression(init: Record<string, unknown> | undefined): Record<string, unknown> | null {
    if (init?.type === "ObjectExpression") return init;
    if (init?.type !== "CallExpression") return null;
    const callee = init.callee as Record<string, unknown> | undefined;
    const object = callee?.object as Record<string, unknown> | undefined;
    const property = callee?.property as Record<string, unknown> | undefined;
    const args = Array.isArray(init.arguments) ? init.arguments as Record<string, unknown>[] : [];
    if (callee?.type !== "MemberExpression" || object?.name !== "Object" || property?.name !== "freeze") return null;
    return args.length === 1 && args[0]?.type === "ObjectExpression" ? args[0] : null;
}

function literalObjectBindings(ast: unknown) {
    const bindings = new Map<string, Record<string, unknown> | null>();
    walkAst(ast, (node) => {
        if (node.type !== "VariableDeclarator") return;
        const id = node.id as Record<string, unknown> | undefined;
        const init = node.init as Record<string, unknown> | undefined;
        const object = frozenObjectExpression(init);
        if (id?.type !== "Identifier" || !object) return;
        const name = String(id.name);
        bindings.set(name, bindings.has(name) ? null : object);
    });
    return bindings;
}

function objectExpressionKeys(objectExpression: Record<string, unknown>, bindings: Map<string, Record<string, unknown> | null>, seen = new Set<string>()): string[] {
    const keys = new Set<string>();
    const properties = Array.isArray(objectExpression.properties) ? objectExpression.properties as Record<string, unknown>[] : [];
    for (const property of properties) {
        if (property.type === "SpreadElement") {
            const argument = property.argument as Record<string, unknown> | undefined;
            if (argument?.type !== "Identifier") continue;
            const name = String(argument.name);
            const binding = bindings.get(name);
            if (!binding || seen.has(name)) continue;
            seen.add(name);
            for (const key of objectExpressionKeys(binding, bindings, seen)) keys.add(key);
            seen.delete(name);
            continue;
        }
        const key = propertyKey(property);
        if (key) keys.add(key);
    }
    return [...keys].sort();
}

function objectExpressionLiteralValues(objectExpression: Record<string, unknown>, bindings: Map<string, Record<string, unknown> | null>, seen = new Set<string>()): Record<string, string | number | boolean | null> {
    const values: Record<string, string | number | boolean | null> = {};
    const properties = Array.isArray(objectExpression.properties) ? objectExpression.properties as Record<string, unknown>[] : [];
    for (const property of properties) {
        if (property.type === "SpreadElement") {
            const argument = property.argument as Record<string, unknown> | undefined;
            if (argument?.type !== "Identifier") continue;
            const name = String(argument.name);
            const binding = bindings.get(name);
            if (!binding || seen.has(name)) continue;
            seen.add(name);
            Object.assign(values, objectExpressionLiteralValues(binding, bindings, seen));
            seen.delete(name);
            continue;
        }
        const key = propertyKey(property);
        const value = property.value as Record<string, unknown> | undefined;
        if (!key || value?.type !== "Literal") continue;
        if (typeof value.value === "string" || typeof value.value === "number" || typeof value.value === "boolean" || value.value === null) {
            values[key] = value.value;
        }
    }
    return values;
}

function realTestCallToolArgumentKeys() {
    const root = join(repoRoot, "scripts", "real-tests");
    return readdirSync(root)
        .filter((file) => file.endsWith(".ts"))
        .flatMap((file) => {
            const text = readFileSync(join(root, file), "utf-8");
            const ast = parseModule(text);
            const bindings = literalObjectBindings(ast);
            const calls: Array<{ file: string; tool: string; keys: string[] }> = [];
            walkAst(ast, (node) => {
                if (node.type !== "CallExpression") return;
                const callee = node.callee as Record<string, unknown> | undefined;
                const args = Array.isArray(node.arguments) ? node.arguments as Record<string, unknown>[] : [];
                const nameArg = args[0];
                const objectArg = args[1];
                if (callee?.type !== "Identifier" || callee.name !== "callTool") return;
                if (nameArg?.type !== "Literal" || typeof nameArg.value !== "string") return;
                if (objectArg?.type !== "ObjectExpression") return;
                calls.push({ file, tool: String(nameArg.value), keys: objectExpressionKeys(objectArg, bindings) });
            });
            return calls;
        });
}

function realTestCallToolLiteralValues() {
    const root = join(repoRoot, "scripts", "real-tests");
    return readdirSync(root)
        .filter((file) => file.endsWith(".ts"))
        .flatMap((file) => {
            const text = readFileSync(join(root, file), "utf-8");
            const ast = parseModule(text);
            const bindings = literalObjectBindings(ast);
            const calls: Array<{ file: string; tool: string; values: Record<string, string | number | boolean | null> }> = [];
            walkAst(ast, (node) => {
                if (node.type !== "CallExpression") return;
                const callee = node.callee as Record<string, unknown> | undefined;
                const args = Array.isArray(node.arguments) ? node.arguments as Record<string, unknown>[] : [];
                const nameArg = args[0];
                const objectArg = args[1];
                if (callee?.type !== "Identifier" || callee.name !== "callTool") return;
                if (nameArg?.type !== "Literal" || typeof nameArg.value !== "string") return;
                if (objectArg?.type !== "ObjectExpression") return;
                calls.push({ file, tool: String(nameArg.value), values: objectExpressionLiteralValues(objectArg, bindings) });
            });
            return calls;
        });
}

const ALWAYS_DESTRUCTIVE_REAL_E2E_TOOLS = new Set([
    "device_broker_shutdown",
    "delete",
    "reset",
    "uninstall_app",
    "clear_app_data",
    "set_battery",
    "set_network",
]);

function realTestDestructiveCallsMissingConfirmation() {
    return realTestCallToolLiteralValues()
        .filter((call) => evaluateDestructivePolicy(toolOperation(call.tool, call.values) || call.tool, call.values).destructive)
        .filter((call) => call.values.confirmDestructive !== true)
        .map((call) => ({ file: call.file, tool: call.tool }));
}

function realTestCallsMissingAnyOfRequired() {
    const anyOfSchemas = advertisedDeviceLabToolAnyOfRequired();
    return realTestCallToolArgumentKeys().flatMap((call) => {
        const anyOf = anyOfSchemas.get(call.tool) || [];
        if (anyOf.length === 0) return [];
        const ok = anyOf.some((required) => required.every((key) => call.keys.includes(key)));
        return ok ? [] : [{ file: call.file, tool: call.tool, anyOf }];
    });
}

function alwaysDestructivePolicyTools() {
    return [...new Set(DESTRUCTIVE_POLICY_SCHEMA_EXAMPLES
        .filter(({ name }) => evaluateDestructivePolicy(name, {}).destructive === true)
        .map(({ name }) => name === "device_broker_shutdown" ? name : publicToolName(name)))]
        .filter((name) => !GROUP_OPERATIONS[name] || Object.values(GROUP_OPERATIONS[name]).every((operation) => evaluateDestructivePolicy(operation, {}).destructive))
        .sort();
}

function realTestText() {
    const root = join(repoRoot, "scripts", "real-tests");
    return readdirSync(root)
        .filter((file) => file.endsWith(".ts"))
        .map((file) => readFileSync(join(root, file), "utf-8"))
        .join("\n");
}

function filesUnder(dir: string, suffixes: string[]): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return filesUnder(path, suffixes);
        if (!entry.isFile()) return [];
        return suffixes.some((suffix) => path.endsWith(suffix)) ? [path] : [];
    });
}

function productionDeviceLabText() {
    const files = [
        ...filesUnder(join(repoRoot, "device-lab-mcp"), [".mjs"]),
        ...filesUnder(join(repoRoot, "packages", "device-lab", "providers"), [".mjs"]),
        ...filesUnder(join(repoRoot, "scripts", "real-tests"), [".ts"]),
        join(repoRoot, "packages", "device-lab", "src", "device-lab-owner.ts"),
        join(repoRoot, "packages", "device-lab", "src", "device-lab-broker.ts"),
        join(repoRoot, "src", "device-lab-admin.ts"),
        join(repoRoot, "src", "docker.ts"),
    ];
    return files.map((file) => `${file}\n${readFileSync(file, "utf-8")}`).join("\n");
}

function realTestCallToolNames() {
    return new Set([...realTestText().matchAll(/callTool\(\s*["']([a-z][a-z0-9_]+)["']/g)].map((match) => match[1]));
}

function realTestCallToolNamesForFile(file: string) {
    const text = readFileSync(join(repoRoot, "scripts", "real-tests", file), "utf-8");
    return new Set([...text.matchAll(/callTool\(\s*["']([a-z][a-z0-9_]+)["']/g)].map((match) => match[1]));
}

function literalStringArrayValues(node: Record<string, unknown> | undefined): string[] {
    if (node?.type !== "ArrayExpression") return [];
    return (Array.isArray(node.elements) ? node.elements as Record<string, unknown>[] : [])
        .filter((element) => element?.type === "Literal" && typeof element.value === "string")
        .map((element) => String(element.value));
}

function deviceLabServerLiteralSets(publicNames = true) {
    const text = readFileSync(join(repoRoot, "device-lab-mcp", "src", "server.mjs"), "utf-8");
    const ast = parseModule(text);
    const sets: Array<{ name: string; values: string[] }> = [];
    walkAst(ast, (node) => {
        if (node.type !== "VariableDeclarator") return;
        const id = node.id as Record<string, unknown> | undefined;
        const init = node.init as Record<string, unknown> | undefined;
        if (id?.type !== "Identifier" || init?.type !== "NewExpression") return;
        const callee = init.callee as Record<string, unknown> | undefined;
        const args = Array.isArray(init.arguments) ? init.arguments as Record<string, unknown>[] : [];
        const arrayArg = args[0];
        if (callee?.type !== "Identifier" || callee.name !== "Set" || arrayArg?.type !== "ArrayExpression") return;
        const values = literalStringArrayValues(arrayArg);
        if (values.length > 0) sets.push({ name: String(id.name), values });
    });
    return publicNames ? sets.map(entry => ({ ...entry, values: entry.values.flatMap(name => name === "device_create" ? Object.keys(CREATE_TOOL_BACKENDS) : [publicToolName(name)]) })) : sets;
}


function brokerAppiumActionKeys() {
    const text = readFileSync(join(repoRoot, "device-lab-mcp", "src", "broker.mjs"), "utf-8");
    const match = /export async function brokerAppium[\s\S]*?const methodByAction = \{([\s\S]*?)\n\s*\};/.exec(text);
    expect(match).not.toBeNull();
    const body = match?.[1] || "";
    return [...body.matchAll(/["']?([a-z][a-z0-9-]*)["']?\s*:/g)]
        .map((item) => item[1])
        .sort();
}

function brokerAppiumForwardedInputKeys() {
    const text = readFileSync(join(repoRoot, "device-lab-mcp", "src", "broker.mjs"), "utf-8").replace(/\r\n/g, "\n");
    const match = /export async function brokerAppium[\s\S]*?params:\s*\{([\s\S]*?)\n\s*\},\n\s*\}\);\n\}/.exec(text);
    expect(match).not.toBeNull();
    const body = match?.[1] || "";
    const forwarded = new Set([...body.matchAll(/\b[a-zA-Z_][a-zA-Z0-9_]*:\s*options\.([a-zA-Z_][a-zA-Z0-9_]*)/g)]
        .map((item) => item[1]));
    if (body.includes("options.appiumPort ?? options.serverPort")) {
        forwarded.add("appiumPort");
        forwarded.add("serverPort");
    }
    return [...forwarded].sort();
}






function publicBrokerRpcMethodKeys() {
    const text = readFileSync(join(repoRoot, "device-lab-mcp", "src", "broker.mjs"), "utf-8");
    const match = /const PUBLIC_BROKER_RPC_METHODS = new Set\(\[([^\]]*)\]\);/.exec(text);
    expect(match).not.toBeNull();
    return [...(match?.[1] || "").matchAll(/["']([^"']+)["']/g)]
        .map((item) => item[1])
        .sort();
}



function deviceLabToolBackendEnums() {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", "import { TOOLS } from './device-lab-mcp/src/tools.mjs'; console.log(JSON.stringify(TOOLS.map((tool) => [tool.name, tool.inputSchema?.properties?.backend?.enum || []])));"], {
        cwd: repoRoot,
        encoding: "utf-8",
    });
    expect(result.status).toBe(0);
    return new Map(JSON.parse(result.stdout) as Array<[string, string[]]>);
}

function deviceLabMcpBackendCapabilities() {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", [
        "import { androidBackend } from '@ccc/device-lab/providers/backends/android.mjs';",
        "import { androidRealBackend } from '@ccc/device-lab/providers/backends/android-device.mjs';",
        "import { iosBackend } from '@ccc/device-lab/providers/backends/ios-simulator.mjs';",
        "import { iosRealBackend } from '@ccc/device-lab/providers/backends/ios-device.mjs';",
        "import { windowsBackend } from '@ccc/device-lab/providers/backends/windows-sandbox.mjs';",
        "import { windowsVmBackend } from '@ccc/device-lab/providers/backends/windows-vm.mjs';",
        "import { macosBackend } from '@ccc/device-lab/providers/backends/macos-vm.mjs';",
        "import { linuxVmBackend } from '@ccc/device-lab/providers/backends/linux-vm.mjs';",
        "const backends = [androidBackend(), androidRealBackend(), iosBackend(), iosRealBackend(), windowsBackend(), windowsVmBackend(), macosBackend(), linuxVmBackend()];",
        "console.log(JSON.stringify(backends.map(({ name, capabilities }) => [name, [...capabilities].sort()])));",
    ].join("")], {
        cwd: repoRoot,
        encoding: "utf-8",
    });
    expect(result.status).toBe(0);
    return new Map((JSON.parse(result.stdout) as Array<[string, string[]]>).map(([backend, names]) => [backend, [...new Set(names.map(publicToolName))].sort()]));
}



function quotedSetConstant(text: string, name: string) {
    const match = new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\);`).exec(text);
    expect(match).not.toBeNull();
    return new Set([...(match?.[1] || "").matchAll(/"([^"]+)"/g)].map((item) => publicToolName(item[1])));
}

function quotedArrayConstant(text: string, name: string) {
    const match = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`).exec(text);
    expect(match).not.toBeNull();
    return new Set([...(match?.[1] || "").matchAll(/"([^"]+)"/g)].map((item) => publicToolName(item[1])));
}

function quotedMapKeys(text: string, name: string) {
    const match = new RegExp(`const ${name} = new Map\\(\\[([\\s\\S]*?)\\]\\);`).exec(text);
    expect(match).not.toBeNull();
    return new Set([...(match?.[1] || "").matchAll(/\["([^"]+)",\s*"[^"]+"\]/g)].map((item) => item[1]));
}

// The broker serves linux-vm through Hyper-V on Windows hosts as well as QEMU in the container.
function hyperVLinuxVmCapabilities(brokerText: string) {
    expect(brokerText).toContain("const HYPER_V_LINUX_VM_CAPABILITIES = [...HYPER_V_VM_CAPABILITIES];");
    return quotedArrayConstant(brokerText, "HYPER_V_VM_CAPABILITIES");
}

function backendAdvertisedSupportDrift() {
    const brokerText = readFileSync(join(repoRoot, "packages", "device-lab", "src", "device-lab-broker.ts"), "utf-8");
    const desktopCapabilities = quotedArrayConstant(brokerText, "DESKTOP_DEVICE_CAPABILITIES");
    const currentDisplayCapabilities = new Set([
        "devices",
        "status",
        "screenshot",
        "click",
        "key",
        "type",
        "scroll",
        "cursor_position",
    ]);
    const capabilityCases = new Map([
        ["x11-current-display", currentDisplayCapabilities],
        ["android-emulator", quotedArrayConstant(brokerText, "ANDROID_EMULATOR_CAPABILITIES")],
        ["android-device", quotedArrayConstant(brokerText, "ANDROID_REAL_CAPABILITIES")],
        ["ios-simulator", quotedArrayConstant(brokerText, "IOS_SIMULATOR_CAPABILITIES")],
        ["ios-device", quotedArrayConstant(brokerText, "IOS_REAL_CAPABILITIES")],
        ["windows-sandbox", desktopCapabilities],
        ["windows-vm", quotedArrayConstant(brokerText, "HYPER_V_VM_CAPABILITIES")],
        ["macos-vm", new Set([...desktopCapabilities, ...quotedArrayConstant(brokerText, "MACOS_VM_CAPABILITIES")])],
        ["linux-vm", new Set([...LINUX_VM_CAPABILITIES.map(publicToolName), ...hyperVLinuxVmCapabilities(brokerText)])],
    ]);
    for (const backend of ["x11-current-display", "windows-vm", "linux-vm"]) capabilityCases.get(backend)?.add("move");
    const schemas = deviceLabToolBackendEnums();
    const backends = [...capabilityCases.keys()];
    const overAdvertised: Array<{ tool: string; backend: string; actual: string[] }> = [];
    const underAdvertised: Array<{ tool: string; backend: string; advertised: string[] }> = [];
    for (const [tool, advertised] of schemas.entries()) {
        if (advertised.length === 0 || tool.startsWith("device_broker_")) continue;
        const actual = backends.filter((backend) => tool === "run_flow"
            ? DEVICE_FLOW_TOOL_NAMES.some((step) => capabilityCases.get(backend)?.has(step))
            : capabilityCases.get(backend)?.has(tool));
        for (const backend of advertised) {
            if (!actual.includes(backend)) overAdvertised.push({ tool, backend, actual });
        }
        for (const backend of actual) {
            if (!advertised.includes(backend) && tool !== "wireless") underAdvertised.push({ tool, backend, advertised });
        }
    }
    return { overAdvertised, underAdvertised };
}

function hostBrokerBackendCapabilities() {
    const brokerText = readFileSync(join(repoRoot, "packages", "device-lab", "src", "device-lab-broker.ts"), "utf-8");
    const desktopCapabilities = quotedArrayConstant(brokerText, "DESKTOP_DEVICE_CAPABILITIES");
    return new Map([
        ["android-emulator", [...quotedArrayConstant(brokerText, "ANDROID_EMULATOR_CAPABILITIES")].sort()],
        ["android-device", [...quotedArrayConstant(brokerText, "ANDROID_REAL_CAPABILITIES")].sort()],
        ["ios-simulator", [...quotedArrayConstant(brokerText, "IOS_SIMULATOR_CAPABILITIES")].sort()],
        ["ios-device", [...quotedArrayConstant(brokerText, "IOS_REAL_CAPABILITIES")].sort()],
        ["windows-sandbox", [...desktopCapabilities].sort()],
        ["windows-vm", [...quotedArrayConstant(brokerText, "HYPER_V_VM_CAPABILITIES")].sort()],
        ["macos-vm", [...new Set([...desktopCapabilities, ...quotedArrayConstant(brokerText, "MACOS_VM_CAPABILITIES")])].sort()],
    ]);
}

function realTestFilesWithCallTool() {
    const root = join(repoRoot, "scripts", "real-tests");
    return readdirSync(root)
        .filter((file) => file.endsWith(".ts"))
        // Vitest specs are not runner call sites: the level 3 node runner never imports them, so
        // they can never be reachable. They also quote `callTool(` as source-inspection text
        // (hyper-v-vm-e2e.test.ts asserts on `callTool("device_stop"` appearing in a function
        // body), which this text match would otherwise read as a real MCP call.
        .filter((file) => !file.endsWith(".test.ts"))
        .filter((file) => /callTool\(/.test(readFileSync(join(root, file), "utf-8")))
        .sort();
}

function reachableRealTestFilesFrom(entryFiles: string[]) {
    const root = join(repoRoot, "scripts", "real-tests");
    const reachable = new Set<string>();
    const visit = (file: string) => {
        if (reachable.has(file)) return;
        reachable.add(file);
        const text = readFileSync(join(root, file), "utf-8");
        for (const match of text.matchAll(/from\s+["']\.\/([^"']+\.ts)["']/g)) {
            visit(match[1]);
        }
    };
    entryFiles.forEach(visit);
    return reachable;
}

function testSupportText() {
    const root = join(repoRoot, "src", "__tests__");
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return files(path);
        if (!entry.isFile() || !path.endsWith(".ts") || path.endsWith("test-level-runner.test.ts")) return [];
        return [path];
    });
    return files(root).map((file) => readFileSync(file, "utf-8")).join("\n");
}

describe("test level runner", () => {
    describe("real MCP snapshot client timeouts", () => {
        it.each([
            ["list", 120000],
            ["create", 150000],
            ["delete", 195000],
            ["restore", 315000],
        ] as const)("keeps %s alive through the server completion and return margin", (action, minimumClientTimeout) => {
            for (const target of [
                {},
                { backend: "windows-vm", provider: "hyper-v" },
                { backend: "linux-vm", provider: "hyper-v" },
            ]) {
                const args = { ...target, action, deviceId: "snapshot-timeout-target" };
                const operation = toolOperation("snapshot", args);
                expect(operation).toBe(`device_snapshot_${action}`);
                const clientTimeout = realMcpToolRequestTimeoutMs("snapshot", args);
                const serverTimeout = brokerDeviceToolExecutionTimeout(operation!, args).rpcTimeoutMs;

                expect(clientTimeout, JSON.stringify(target)).toBeGreaterThanOrEqual(minimumClientTimeout);
                expect(clientTimeout, JSON.stringify(target)).toBeGreaterThanOrEqual(serverTimeout! + 30000);
            }
        });

        it.each([
            { backend: "macos-vm", provider: "tart" },
            { backend: "linux-vm", provider: "container-qemu" },
        ])("retains the existing default for unrelated snapshot provider $provider", (target) => {
            for (const action of ["list", "create", "delete", "restore"]) {
                expect(realMcpToolRequestTimeoutMs("snapshot", { ...target, action })).toBe(120000);
            }
        });

        it("keeps explicit RPC and operation timeout precedence ahead of the snapshot default", () => {
            for (const target of [{}, { backend: "linux-vm", provider: "hyper-v" }]) {
                const args = { ...target, action: "restore" };
                expect(realMcpToolRequestTimeoutMs("snapshot", {
                    ...args, rpcTimeoutMs: 150000, timeoutMs: 600000,
                })).toBe(165000);
                expect(realMcpToolRequestTimeoutMs("snapshot", {
                    ...args, timeoutMs: 450000,
                })).toBe(480000);
                expect(realMcpToolRequestTimeoutMs("snapshot", {
                    ...args, rpcTimeoutMs: 1000,
                })).toBe(120000);
                expect(realMcpToolRequestTimeoutMs("snapshot", {
                    ...args, timeoutMs: 1000,
                })).toBe(120000);
            }
        });

        it("retains the existing non-snapshot client timeout policies", () => {
            expect(realMcpToolRequestTimeoutMs("status")).toBe(120000);
            expect(realMcpToolRequestTimeoutMs("start", { waitForBoot: true, bootTimeoutMs: 180000 })).toBe(210000);
            expect(realMcpToolRequestTimeoutMs("exec", { timeoutMs: 180000 })).toBe(210000);
            expect(realMcpToolRequestTimeoutMs("clipboard", { backend: "android-emulator" })).toBe(360000);
        });
    });

    it("does not stop a pre-existing foreign Windows Sandbox session during single-use recovery", async () => {
        const foreignId = "11111111-1111-4111-8111-111111111111";
        const stopped: string[] = [];
        const runner = (_command: string, args: string[]) => {
            if (args[0] === "list") return { status: 0, stdout: JSON.stringify([{ id: foreignId }]), stderr: "" };
            if (args[0] === "stop") stopped.push(args[2]);
            return { status: 0, stdout: "", stderr: "" };
        };
        const callTool = vi.fn(async (tool: string) => {
            if (tool === "start") return mcpTextResult("CO_E_APPSINGLEUSE", true);
            return mcpTextResult({ device: { id: "windows-real-sandbox-test", status: "stopped" } });
        });

        await expect(startWindowsSandboxE2EDevice(callTool, "windows-real-sandbox-test", {
            wsb: "wsb",
            runner,
            retryDelayMs: 0,
        })).rejects.toThrow(/^mcp-tool-failed/);
        expect(callTool.mock.calls.filter(([tool]) => tool === "start")).toHaveLength(1);
        expect(stopped).toEqual([]);
    });

    it("stops only the verified test-owned Windows Sandbox session when a foreign session appears concurrently", async () => {
        const preExistingId = "11111111-1111-4111-8111-111111111111";
        const ownedId = "22222222-2222-4222-8222-222222222222";
        const concurrentForeignId = "33333333-3333-4333-8333-333333333333";
        const stopped: string[] = [];
        let listCount = 0;
        const runner = (_command: string, args: string[]) => {
            if (args[0] === "list") {
                listCount += 1;
                const ids = listCount === 1
                    ? [preExistingId]
                    : stopped.includes(ownedId)
                        ? [preExistingId, concurrentForeignId]
                        : [preExistingId, ownedId, concurrentForeignId];
                return { status: 0, stdout: JSON.stringify(ids.map((id) => ({ id }))), stderr: "" };
            }
            if (args[0] === "stop") stopped.push(args[2]);
            return { status: 0, stdout: "", stderr: "" };
        };
        let startCount = 0;
        const startBudgets: unknown[] = [];
        const callTool = async (tool: string, args: any) => {
            if (tool === "status") {
                return mcpTextResult({ device: { deviceId: "windows-real-sandbox-test", status: "running", sandboxId: ownedId } });
            }
            startCount += 1;
            startBudgets.push({ boot: args.bootTimeoutMs, transport: realMcpToolRequestTimeoutMs(tool, args) });
            return startCount === 1
                ? mcpTextResult("CO_E_APPSINGLEUSE", true)
                : mcpTextResult({ device: { deviceId: "windows-real-sandbox-test", status: "running", sandboxId: ownedId } });
        };

        const started = await startWindowsSandboxE2EDevice(callTool, "windows-real-sandbox-test", {
            wsb: "wsb",
            runner,
            retryDelayMs: 0,
            bootTimeoutMs: 180000,
        });
        expect(started.device.sandboxId).toBe(ownedId);
        expect(startBudgets).toEqual([{ boot: 180000, transport: 210000 }, { boot: 180000, transport: 210000 }]);
        expect(stopped).toEqual([ownedId]);
        expect(stopped).not.toContain(preExistingId);
        expect(stopped).not.toContain(concurrentForeignId);
    });

    it("keeps level 0 mapped to the default vitest suite", () => {
        const plan = dryRun("0");

        expect(plan.level).toBe(0);
        expect(plan.env.CCC_TEST_LEVEL).toBe("0");
        expect(plan.args).toEqual(expect.arrayContaining(["run"]));
        expect(plan.args).not.toEqual(expect.arrayContaining(["src/__tests__/device-lab.real-provider-readiness.test.ts"]));
    });

    it("maps opt-in real levels to focused real-environment tests", () => {
        const level1 = dryRun("level1");
        const level2 = dryRun("2");
        const level3 = dryRun("3");

        expect(level1.args).toEqual(expect.arrayContaining(["src/__tests__/device-lab.real-provider-readiness.test.ts"]));
        expect(level1.args).toEqual(expect.arrayContaining(["--reporter", "verbose"]));
        expect(level2.args).toEqual(expect.arrayContaining([
            "src/__tests__/device-lab.real-provider-readiness.test.ts",
            "src/__tests__/device-lab.real-host-integration.test.ts",
            "src/__tests__/device-lab.real-ios-e2e.test.ts",
            "src/__tests__/device-lab.real-android-emulator-e2e.test.ts",
            "src/__tests__/device-lab.real-macos-vm-e2e.test.ts",
            "src/__tests__/device-lab.real-windows-sandbox.test.ts",
            "src/__tests__/device-lab-mcp.real-linux-vm.test.ts",
        ]));
        expect(level3.args).toEqual(expect.arrayContaining([
            "src/__tests__/device-lab.real-destructive.test.ts",
        ]));
    });

    it("prints usage for invalid levels without running vitest", () => {
        const result = spawnSync(process.execPath, [runner, "9"], {
            cwd: repoRoot,
            encoding: "utf-8",
        });

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("Usage: node scripts/test-level.js");
    });

    it("can target self-contained node tests for installed package fallback", () => {
        const level2 = dryRunNode("2");

        expect(level2.mode).toBe("node-test");
        expect(level2.args.slice(0, 3)).toEqual([
            "--import",
            repoLoader,
            join(repoRoot, "scripts", "real-tests", "run.ts"),
        ]);
        expect(level2.args).toContain(join(repoRoot, "scripts", "real-tests", "run.ts"));
        expect(level2.args).toContain(join(repoRoot, "scripts", "real-tests", "level0-package-smoke.ts"));
        expect(level2.args).toContain(join(repoRoot, "scripts", "real-tests", "level1-real-provider-readiness.ts"));
        expect(level2.args).toContain(join(repoRoot, "scripts", "real-tests", "level1-dist-real-provider-readiness.ts"));
        expect(level2.args).toContain(join(repoRoot, "scripts", "real-tests", "level1-display-e2e.ts"));
        expect(level2.args).toContain(join(repoRoot, "scripts", "real-tests", "level2-host-integration-slots.ts"));
        expect(level2.args).toContain(join(repoRoot, "scripts", "real-tests", "level2-broker-e2e.ts"));
        expect(level2.args).toContain(join(repoRoot, "scripts", "real-tests", "level2-dist-broker-e2e.ts"));
        expect(level2.args).toContain(join(repoRoot, "scripts", "real-tests", "level2-ios-e2e.ts"));
        expect(level2.args).toContain(join(repoRoot, "scripts", "real-tests", "level2-android-emulator-e2e.ts"));
        expect(level2.args).toContain(join(repoRoot, "scripts", "real-tests", "level2-android-device-e2e.ts"));
        expect(level2.args).toContain(join(repoRoot, "scripts", "real-tests", "level2-macos-vm-e2e.ts"));
        expect(level2.args).toContain(join(repoRoot, "scripts", "real-tests", "level2-windows-sandbox.ts"));
        expect(level2.args).toContain(join(repoRoot, "scripts", "real-tests", "level2-real-linux-vm.ts"));

        const level3 = dryRunNode("3");
        expect(level3.mode).toBe("node-test");
        expect(level3.args).toContain(join(repoRoot, "scripts", "real-tests", "level0-package-smoke.ts"));
        expect(level3.args).toContain(join(repoRoot, "scripts", "real-tests", "level1-dist-real-provider-readiness.ts"));
        expect(level3.args).toContain(join(repoRoot, "scripts", "real-tests", "level2-broker-e2e.ts"));
        expect(level3.args).toContain(join(repoRoot, "scripts", "real-tests", "level2-dist-broker-e2e.ts"));
        expect(level3.args).toContain(join(repoRoot, "scripts", "real-tests", "level2-android-device-e2e.ts"));
        expect(level3.args).not.toContain(join(repoRoot, "scripts", "real-tests", "level2-android-emulator-e2e.ts"));
        expect(level3.args).toContain(join(repoRoot, "scripts", "real-tests", "level3-real-destructive.ts"));
        expect(level3.args).toEqual(expect.arrayContaining(["--provider-concurrency", "2"]));
    });

    it("validates and forwards the Level 3 provider concurrency override", () => {
        const result = spawnSync(process.execPath, [runner, "3", "--dry-run", "--provider-concurrency", "4"], {
            cwd: repoRoot,
            encoding: "utf-8",
        });
        expect(result.status).toBe(0);
        const plan = JSON.parse(result.stdout) as { args: string[]; mode: string };
        expect(plan.mode).toBe("node-test");
        expect(plan.args).toEqual(expect.arrayContaining(["--provider-concurrency", "4"]));

        const invalid = spawnSync(process.execPath, [runner, "3", "--dry-run", "--node-test", "--provider-concurrency", "0"], {
            cwd: repoRoot,
            encoding: "utf-8",
        });
        expect(invalid.status).toBe(1);
        expect(invalid.stderr).toContain("Provider concurrency must be an integer from 1 to 8");
        expect(() => normalizeProviderConcurrency("9", 2)).toThrow("integer from 1 to 8");
    });

    it("partitions provider modules from serial Level 3 setup modules", () => {
        const files = [
            "/repo/scripts/real-tests/level2-broker-e2e.ts",
            "/repo/scripts/real-tests/level2-hyper-v-windows-vm.ts",
            "/repo/scripts/real-tests/level3-real-destructive.ts",
        ];
        const partitioned = partitionProviderFiles(files);
        expect(partitioned.serial).toEqual([files[0]]);
        expect(partitioned.providers).toEqual([
            { file: files[1], resources: ["hyper-v", "host-virtualization"] },
            { file: files[2], resources: ["android-emulator", "macos-vm", "host-virtualization"] },
        ]);
    });

    it("runs independent providers concurrently while serializing shared resources", async () => {
        const events: string[] = [];
        let active = 0;
        let maxActive = 0;
        const items = [
            { file: "macos-a", resources: ["macos-vm"] },
            { file: "windows", resources: ["windows-sandbox"] },
            { file: "macos-b", resources: ["macos-vm"] },
        ];
        const results = await runResourceAware(items, 2, async (file) => {
            events.push(`start:${file}`);
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
            active -= 1;
            events.push(`end:${file}`);
            return file;
        });

        expect(results).toEqual(["macos-a", "windows", "macos-b"]);
        expect(maxActive).toBe(2);
        expect(events.indexOf("start:macos-b")).toBeGreaterThan(events.indexOf("end:macos-a"));
    });

    it("serializes host virtualization while allowing a physical provider concurrently", async () => {
        const events: string[] = [];
        let active = 0;
        let maxActive = 0;
        await runResourceAware([
            { file: "hyper-v", resources: ["hyper-v", "host-virtualization"] },
            { file: "android", resources: ["android-device"] },
            { file: "windows", resources: ["windows-sandbox", "host-virtualization"] },
        ], 2, async (file) => {
            events.push(`start:${file}`);
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
            active -= 1;
            events.push(`end:${file}`);
            return file;
        });

        expect(events.indexOf("start:android")).toBeLessThan(events.indexOf("end:hyper-v"));
        expect(events.indexOf("start:windows")).toBeGreaterThan(events.indexOf("end:hyper-v"));
        expect(maxActive).toBe(2);
    });

    it("waits for active providers before reporting a scheduler failure", async () => {
        const events: string[] = [];
        await expect(runResourceAware([
            { file: "failing", resources: ["android-device"] },
            { file: "finishing", resources: ["windows-sandbox"] },
        ], 2, async (file) => {
            events.push(`start:${file}`);
            if (file === "failing") throw new Error("provider failed");
            await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
            events.push(`end:${file}`);
            return file;
        })).rejects.toThrow("provider failed");
        expect(events).toContain("end:finishing");
    });

    it("executes provider modules in isolated child processes and keeps summary order", () => {
        const tempDir = mkdtempSync(join(tmpdir(), "ccc-provider-workers-"));
        writeFileSync(join(tempDir, "package.json"), JSON.stringify({ type: "module" }));
        const windowsFile = join(tempDir, "level2-android-device-e2e.ts");
        const linuxFile = join(tempDir, "level2-windows-sandbox.ts");
        const windowsStarted = join(tempDir, "windows.started");
        const linuxStarted = join(tempDir, "linux.started");
        const summaryFile = join(tempDir, "summary.json");
        const moduleText = (name: string, ownMarker: string, peerMarker: string) => `
            import { existsSync, writeFileSync } from "fs";
            export const name = ${JSON.stringify(name)};
            export async function run() {
                writeFileSync(${JSON.stringify(ownMarker)}, String(process.pid));
                const deadline = Date.now() + 20_000;
                while (!existsSync(${JSON.stringify(peerMarker)}) && Date.now() < deadline) {
                    await new Promise((resolve) => setTimeout(resolve, 20));
                }
                return existsSync(${JSON.stringify(peerMarker)})
                    ? { status: "PASS" }
                    : { status: "FAIL", reason: "peer provider did not start concurrently" };
            }
        `;
        writeFileSync(windowsFile, moduleText("windows worker", windowsStarted, linuxStarted));
        writeFileSync(linuxFile, moduleText("sandbox worker", linuxStarted, windowsStarted));
        try {
            const result = spawnSync(process.execPath, [
                "--import", repoLoader,
                join(repoRoot, "scripts", "real-tests", "run.ts"),
                "--compact",
                "--provider-concurrency",
                "2",
                "--json-summary-file",
                summaryFile,
                windowsFile,
                linuxFile,
            ], {
                cwd: repoRoot,
                encoding: "utf-8",
                timeout: 60_000,
            });
            expect(result.status, result.stderr || result.stdout).toBe(0);
            const summary = JSON.parse(readFileSync(summaryFile, "utf-8")) as {
                records: Array<{ test: string; status: string }>;
            };
            expect(summary.records).toEqual([
                expect.objectContaining({ test: "windows worker", status: "PASS" }),
                expect.objectContaining({ test: "sandbox worker", status: "PASS" }),
            ]);
            expect(readFileSync(windowsStarted, "utf-8")).not.toBe(String(process.pid));
            expect(readFileSync(linuxStarted, "utf-8")).not.toBe(String(process.pid));
        } finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    }, 70_000);

    it("collects a provider worker exception as a failed real-test record", () => {
        const tempDir = mkdtempSync(join(tmpdir(), "ccc-provider-worker-failure-"));
        writeFileSync(join(tempDir, "package.json"), JSON.stringify({ type: "module" }));
        const providerFile = join(tempDir, "level2-hyper-v-windows-vm.ts");
        const summaryFile = join(tempDir, "summary.json");
        writeFileSync(providerFile, `
            export const name = "worker failure";
            export async function run() {
                throw new Error("intentional worker failure");
            }
        `);
        try {
            const result = spawnSync(process.execPath, [
                "--import", repoLoader,
                join(repoRoot, "scripts", "real-tests", "run.ts"),
                "--compact",
                "--provider-concurrency",
                "2",
                "--json-summary-file",
                summaryFile,
                providerFile,
            ], {
                cwd: repoRoot,
                encoding: "utf-8",
                timeout: 30_000,
            });
            expect(result.status).toBe(1);
            const summary = JSON.parse(readFileSync(summaryFile, "utf-8")) as {
                records: Array<{ test: string; status: string; reason?: string }>;
            };
            expect(summary.records).toEqual([
                expect.objectContaining({
                    test: "worker failure",
                    status: "FAIL",
                    reason: "intentional worker failure",
                }),
            ]);
        } finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    }, 40_000);

    it.each([
        { mode: "sequential", fileName: "failed-evidence.mjs", args: [] },
        { mode: "provider worker", fileName: "level2-ios-e2e.ts", args: ["--provider-concurrency", "2"] },
    ])("retains ordered MCP evidence when a $mode module throws", ({ mode, fileName, args }) => {
        const tempDir = mkdtempSync(join(tmpdir(), "ccc-failed-module-evidence-"));
        const fixtureFile = join(tempDir, fileName);
        const serverFile = join(tempDir, "fixture-server.mjs");
        const requestsFile = join(tempDir, "requests.jsonl");
        const modulePidFile = join(tempDir, "module.pid");
        const summaryFile = join(tempDir, "summary.json");
        const moduleName = `failed ${mode} evidence`;
        const clientUrl = pathToFileURL(join(repoRoot, "scripts", "real-tests", "device-lab-mcp-client.ts")).href;
        const toolsUrl = pathToFileURL(join(repoRoot, "device-lab-mcp", "src", "tools.mjs")).href;
        const sensitiveOutput = "fixture-private-output-must-not-enter-proof";
        writeFileSync(join(tempDir, "package.json"), JSON.stringify({ type: "module" }));
        writeFileSync(serverFile, [
            'import { appendFileSync } from "fs";',
            'import { createInterface } from "readline";',
            `import { TOOLS } from ${JSON.stringify(toolsUrl)};`,
            'createInterface({ input: process.stdin }).on("line", (line) => {',
            '  const request = JSON.parse(line);',
            '  if (request.id === undefined) return;',
            '  let result;',
            '  if (request.method === "initialize") {',
            '    result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "failed-module-fixture", version: "1" } };',
            '  } else if (request.method === "tools/list") {',
            '    result = { tools: TOOLS };',
            '  } else if (request.method === "tools/call") {',
            `    appendFileSync(${JSON.stringify(requestsFile)}, JSON.stringify(request.params.name) + "\\n");`,
            '    const isError = request.params.name === "exec";',
            '    const payload = isError',
            `      ? { ok: false, error: "provider-command-failed", stderr: ${JSON.stringify(sensitiveOutput)} }`,
            '      : { ok: true, backend: "ios-simulator", devices: [{ deviceId: "retained-device", backend: "ios-simulator" }], device: { deviceId: "retained-device", backend: "ios-simulator" } };',
            '    result = { isError, content: [{ type: "text", text: JSON.stringify(payload) }] };',
            '  } else {',
            '    throw new Error("Unexpected fixture request: " + request.method);',
            '  }',
            '  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");',
            '});',
        ].join("\n"));
        writeFileSync(fixtureFile, [
            'import { writeFileSync } from "fs";',
            `import { withDeviceLabMcp } from ${JSON.stringify(clientUrl)};`,
            `export const name = ${JSON.stringify(moduleName)};`,
            'export async function run() {',
            `  writeFileSync(${JSON.stringify(modulePidFile)}, String(process.pid));`,
            '  await withDeviceLabMcp(async ({ callTool }) => {',
            '    await callTool("devices", { backend: "ios-simulator" });',
            '    await callTool("status", { deviceId: "retained-device" });',
            '    await callTool("exec", { deviceId: "retained-device", command: "fixture-command" });',
            '    await callTool("status", { deviceId: "retained-device", unsupportedFixtureField: true });',
            `  }, { serverPath: ${JSON.stringify(serverFile)}, name: "retained-fixture-session" });`,
            '  throw new Error("intentional failure after MCP observations");',
            '}',
        ].join("\n"));
        try {
            const result = spawnSync(process.execPath, [
                "--import", repoLoader,
                join(repoRoot, "scripts", "real-tests", "run.ts"),
                "--compact",
                ...args,
                "--fail-on-coverage-gap",
                "--json-summary",
                "--json-summary-file", summaryFile,
                fixtureFile,
            ], { cwd: repoRoot, encoding: "utf-8", timeout: 30_000 });
            expect(result.status, result.stderr || result.stdout).toBe(1);
            expect(result.error).toBeUndefined();
            const summary = JSON.parse(readFileSync(summaryFile, "utf-8"));
            expect(summary).toEqual(expect.objectContaining({ total: 1, pass: 0, skip: 0, fail: 1 }));
            expect(summary.records).toEqual([{
                file: fixtureFile,
                test: moduleName,
                status: "FAIL",
                reason: "intentional failure after MCP observations",
            }]);
            expect(result.stderr).toContain(`FAIL ${moduleName} - intentional failure after MCP observations`);
            const modulePid = Number(readFileSync(modulePidFile, "utf-8"));
            if (mode === "sequential") expect(modulePid).toBe(result.pid);
            else expect(modulePid).not.toBe(result.pid);

            expect(summary.mcpSessions).toEqual([expect.objectContaining({
                file: fixtureFile,
                test: moduleName,
                id: "mcp-session-1",
                name: "retained-fixture-session",
                serverPath: serverFile,
                serverSource: "source",
                serverFile: expect.objectContaining({ exists: true, size: expect.any(Number), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
                advertisedToolSurface: canonicalDeviceLabToolSurface(),
                envOverrides: [],
            })]);
            const calls = summary.toolCoverage.calls;
            const observedRequests = readFileSync(requestsFile, "utf-8").trim().split("\n").map(line => JSON.parse(line));
            expect(observedRequests).toEqual(["devices", "status", "exec", "status"]);
            expect(calls.map((call: any) => call.tool)).toEqual(observedRequests);
            expect(calls.map((call: any) => call.mcpSessionId)).toEqual(Array(4).fill(summary.mcpSessions[0].id));
            expect(calls.map((call: any) => call.outcome)).toEqual(["ok", "ok", "error-result", "ok"]);
            expect(calls.map((call: any) => call.schemaValid)).toEqual([true, true, true, false]);
            expect(calls[1]).toEqual(expect.objectContaining({ observedBackend: "ios-simulator", facets: ["status:backend=ios-simulator"] }));
            expect(summary.toolCoverage.calledArgumentFacets).toEqual(expect.arrayContaining([
                "devices:backend=ios-simulator", "status:backend=ios-simulator",
            ]));
            expect(summary.toolCoverage.argumentSchemaFailureRecords).toEqual([expect.objectContaining({
                test: moduleName,
                tool: "status",
                schemaErrors: ["status does not support unsupportedFixtureField"],
            })]);
            expect(summary.toolCoverage.unexpectedErrorResultRecords).toEqual([expect.objectContaining({
                test: moduleName,
                tool: "exec",
                errorCode: "provider-command-failed",
            })]);
            expect(summary.toolCoverage.expectedErrorResultRecords).toEqual([]);
            expect(result.stdout).toMatch(/strictCoverageFailures=[1-9]\d*/);
            expect(result.stdout).toMatch(/strictOutcomeFailures=[1-9]\d*/);
            const summaryLine = result.stdout.split(/\r?\n/).find(line => line.startsWith("JSON_SUMMARY "));
            expect(JSON.parse(summaryLine!.slice("JSON_SUMMARY ".length))).toEqual(summary);
            expect(JSON.stringify(summary)).not.toContain(sensitiveOutput);
        } finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    }, 40_000);

    it("terminates active provider workers when the collector is interrupted", async () => {
        const tempDir = mkdtempSync(join(tmpdir(), "ccc-provider-worker-signal-"));
        writeFileSync(join(tempDir, "package.json"), JSON.stringify({ type: "module" }));
        const providerFile = join(tempDir, "level2-windows-sandbox.ts");
        const workerPidFile = join(tempDir, "worker.pid");
        const grandchildPidFile = join(tempDir, "grandchild.pid");
        writeFileSync(providerFile, `
            import { spawn } from "child_process";
            import { writeFileSync } from "fs";
            export const name = "interrupt worker";
            export async function run() {
                writeFileSync(${JSON.stringify(workerPidFile)}, String(process.pid));
                const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
                    stdio: "ignore",
                    windowsHide: true,
                });
                writeFileSync(${JSON.stringify(grandchildPidFile)}, String(grandchild.pid));
                await new Promise((resolve) => setTimeout(resolve, 30_000));
                return { status: "PASS" };
            }
        `);
        const collector = spawn(process.execPath, [
            "--import", repoLoader,
            join(repoRoot, "scripts", "real-tests", "run.ts"),
            "--compact",
            "--provider-concurrency",
            "2",
            providerFile,
        ], {
            cwd: repoRoot,
            stdio: "ignore",
            windowsHide: true,
        });
        try {
            const deadline = Date.now() + 30_000;
            while ((!existsSync(workerPidFile) || !existsSync(grandchildPidFile)) && Date.now() < deadline) {
                await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
            }
            expect(existsSync(workerPidFile)).toBe(true);
            expect(existsSync(grandchildPidFile)).toBe(true);
            const workerPid = Number(readFileSync(workerPidFile, "utf-8"));
            const grandchildPid = Number(readFileSync(grandchildPidFile, "utf-8"));
            expect(Number.isInteger(workerPid)).toBe(true);
            expect(Number.isInteger(grandchildPid)).toBe(true);
            const killSignal = "SIGTERM";
            collector.kill(killSignal);
            const collectorExit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise) => {
                collector.once("close", (code, signal) => resolvePromise({ code, signal }));
            });
            expect(
                collectorExit.signal === killSignal
                || collectorExit.code === (process.platform === "win32" ? 1 : 143),
            ).toBe(true);

            for (const pid of [workerPid, grandchildPid]) {
                const workerDeadline = Date.now() + 5000;
                let processAlive = true;
                while (processAlive && Date.now() < workerDeadline) {
                    try {
                        process.kill(pid, 0);
                        if (process.platform === "linux") {
                            const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
                            if (/\)\s+Z\s/.test(stat)) {
                                processAlive = false;
                                break;
                            }
                        }
                        await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
                    } catch {
                        processAlive = false;
                    }
                }
                expect(processAlive).toBe(false);
            }
        } finally {
            if (collector.exitCode === null) collector.kill("SIGKILL");
            rmSync(tempDir, { recursive: true, force: true });
        }
    }, 40_000);

    it("always uses the current checkout CLI for real broker autolaunch", async () => {
        const { localCccPathEnv } = await import("../../scripts/real-tests/helpers.ts") as {
            localCccPathEnv: (env?: NodeJS.ProcessEnv) => { ok: boolean; source?: string; env?: NodeJS.ProcessEnv; cleanup: () => void };
        };
        const originalPath = process.platform === "win32" ? "C:\\global-ccc" : "/global-ccc";
        const result = localCccPathEnv({ ...process.env, PATH: originalPath });
        try {
            expect(result.ok).toBe(true);
            expect(result.source).toBe("local-dist");
            expect(result.env?.PATH).not.toBe(originalPath);
            expect(result.env?.PATH?.endsWith(originalPath)).toBe(true);
        } finally {
            result.cleanup();
        }
    });

    it("can require full real E2E coverage by failing on skips and coverage gaps in the node runner", () => {
        const result = spawnSync(process.execPath, [runner, "3", "--dry-run", "--fail-on-skip", "--fail-on-coverage-gap", "--json-summary"], {
            cwd: repoRoot,
            encoding: "utf-8",
        });
        expect(result.status).toBe(0);
        const plan = JSON.parse(result.stdout) as { mode: string; args: string[]; env: Record<string, string> };
        expect(plan.mode).toBe("node-test");
        expect(plan.args).toContain("--fail-on-skip");
        expect(plan.args).toContain("--fail-on-coverage-gap");
        expect(plan.args).toContain("--json-summary");
        expect(plan.env.CCC_REAL_DEVICE_LAB_FAIL_ON_SKIP).toBe("1");
    });

    it("exposes the four device-lab levels and focused Hyper-V Level 3 commands", () => {
        const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8")) as {
            scripts?: Record<string, string>;
        };
        expect(pkg.scripts?.["test:level3"]).toBe("node scripts/real-tests/level3.ts");
        expect(Object.keys(pkg.scripts || {}).filter((name) => name.startsWith("test:level"))).toEqual([
            "test:level0",
            "test:level1",
            "test:level2",
            "test:level3",
            "test:level3:hyper-v",
            "test:level3:hyper-v:windows",
            "test:level3:hyper-v:windows:library",
            "test:level3:hyper-v:windows:network:library",
            "test:level3:hyper-v:linux",
        ]);
    });

    it("treats the explicit Level 3 command as destructive authorization without an environment switch", () => {
        const level3Text = readFileSync(join(repoRoot, "scripts", "real-tests", "level3.ts"), "utf-8");
        const vitestText = readFileSync(join(repoRoot, "scripts", "real-tests", "level3-vitest.ts"), "utf-8");
        const configText = readFileSync(join(repoRoot, "scripts", "real-tests", "vitest.level3.config.ts"), "utf-8");
        const destructiveText = readFileSync(join(repoRoot, "scripts", "real-tests", "level3-real-destructive.ts"), "utf-8");
        expect(level3Text).toContain('vitest, "run", "--config", config');
        expect(level3Text).toContain("buildLevel3Artifacts(repoRoot, { env })");
        expect(level3Text).toContain("ensureHostBrokerReady(repoRoot, { env })");
        expect(level3Text).toContain('from "./support/level3-host.ts"');
        expect(vitestText).toMatch(/runner,\s*"3"/);
        expect(vitestText).toContain('"--platform-result"');
        expect(vitestText).toContain("for (const record of records)");
        expect(vitestText).toContain("for (const [index, record] of testRecords.entries())");
        expect(vitestText).toContain("it.skip");
        expect(vitestText).toContain('it("validates provider coverage matrix"');
        expect(vitestText).not.toContain('it("runs the real provider suite"');
        expect(vitestText).not.toContain('"--fail-on-coverage-gap"');
        expect(vitestText).toContain('key !== "VITEST" && !key.startsWith("VITEST_")');
        expect(configText).toContain('include: ["scripts/real-tests/level3-vitest.ts"]');
        expect(configText).toContain("testTimeout: 10 * 60 * 60 * 1000");
        expect(destructiveText).toContain("destructive: true");
        expect(destructiveText).toContain("snapshot: true");
    });

    it("resolves the real-test repository root from Windows file URLs", async () => {
        const { repositoryRootFromModuleUrl } = await import("../../scripts/real-tests/helpers.ts") as {
            repositoryRootFromModuleUrl: (moduleUrl: string, options?: { windows?: boolean }) => string;
        };
        const moduleUrl = "file:///C:/Users/TestUser/Project/_Project/claude-code-container/scripts/real-tests/helpers.ts";

        expect(repositoryRootFromModuleUrl(moduleUrl, { windows: true })).toBe(
            "C:\\Users\\TestUser\\Project\\_Project\\claude-code-container\\",
        );
    });

    it("requires packaged real-provider evidence while retaining source and dist tool coverage", async () => {
        const { assertResultMatrix } = await import("../../scripts/real-tests/assert-matrix.ts") as {
            assertResultMatrix: (shards: unknown[], options?: Record<string, unknown>) => Record<string, unknown>;
        };
        const shard = {
            host: { platform: "test", arch: "x64", node: process.version },
            pass: 1,
            skip: 0,
            fail: 0,
            strictCoverageFailures: 0,
            strictOutcomeFailures: 0,
            mcpSessions: [
                { id: "source-session", serverSource: "source" },
                { id: "dist-session", serverSource: "dist" },
            ],
            records: [],
            toolCoverage: {
                advertisedTools: ["create"],
                calls: [
                    { file: "/results/provider-e2e.mjs", tool: "create", outcome: "ok", mcpSessionId: "source-session", facets: ["create:backend=test-provider"] },
                    { file: "/results/provider-e2e.mjs", tool: "create", outcome: "ok", mcpSessionId: "dist-session", facets: ["create:backend=test-provider"] },
                ],
            },
        };
        const options = {
            advertisedTools: ["create"],
            providerSpecs: [{ id: "test-provider", files: ["provider-e2e.mjs"], tools: ["create"] }],
            requireLinuxVm: false,
        };

        expect(assertResultMatrix([shard], options)).toEqual(expect.objectContaining({
            ok: true,
            failures: [],
            missingPublicDirectOkBySource: { source: [], dist: [] },
        }));

        const wrongFile = structuredClone(shard);
        wrongFile.toolCoverage.calls[1].file = "/results/level2-broker-e2e.ts";
        expect(assertResultMatrix([wrongFile], options)).toEqual(expect.objectContaining({
            ok: false,
            failures: expect.arrayContaining(["missingProviderEvidence:test-provider:dist=1"]),
        }));

        const missingDist = structuredClone(shard);
        missingDist.toolCoverage.calls = missingDist.toolCoverage.calls.filter((call) => call.mcpSessionId !== "dist-session");
        expect(assertResultMatrix([missingDist], options)).toEqual(expect.objectContaining({
            ok: false,
            failures: expect.arrayContaining([
                "missingPublicDirectOk:dist=1",
                "missingProviderEvidence:test-provider:dist=1",
            ]),
        }));
    });

    it("selects the node runner when a JSON summary is requested", () => {
        const result = spawnSync(process.execPath, [runner, "1", "--dry-run", "--json-summary", "--json-summary-file", "results/summary.json"], {
            cwd: repoRoot,
            encoding: "utf-8",
        });
        expect(result.status).toBe(0);
        const plan = JSON.parse(result.stdout) as { mode: string; args: string[] };
        expect(plan.mode).toBe("node-test");
        expect(plan.args).toContain("--json-summary");
        expect(plan.args).toEqual(expect.arrayContaining(["--json-summary-file", "results/summary.json"]));
        expect(plan.args).toContain(join(repoRoot, "scripts", "real-tests", "run.ts"));
        expect(plan.args).toContain(join(repoRoot, "scripts", "real-tests", "level1-display-e2e.ts"));
    });

    it("runs device-lab real E2E operations through the MCP server instead of backend handlers", () => {
        for (const file of [
            "android-emulator-e2e.ts",
            "ios-e2e.ts",
            "windows-sandbox-e2e.ts",
            "macos-vm-e2e.ts",
        ]) {
            const text = readFileSync(join(repoRoot, "scripts", "real-tests", file), "utf-8");
            expect(text).toContain("withDeviceLabMcp");
            expect(text).not.toContain("CCC_DEVICE_LAB_OWNER_BASIS");
            expect(text).not.toMatch(/\bhandle(?:Android|Ios|IosReal|Windows|Macos)Tool\b/);
        }
        const helperText = readFileSync(join(repoRoot, "scripts", "real-tests", "device-lab-mcp-client.ts"), "utf-8");
        expect(helperText).toContain("serverPath");
        expect(helperText).toContain("CCC_REAL_DEVICE_LAB_MCP_SERVER");
        expect(helperText).not.toContain("NODE_ENV");
        expect(helperText).not.toContain("CCC_DEVICE_LAB_OWNER_BASIS");
    });

    it("keeps device-lab MCP production paths free of legacy env transport contracts", () => {
        const text = productionDeviceLabText();
        for (const forbidden of [
            "CCC_DEVICE_LAB_OWNER_BASIS",
            "CCC_DEVICE_LAB_IMPLICIT_BROKER",
            "CCC_DEVICE_LAB_BACKEND_MODULE_URL",
            "CCC_DEVICE_LAB_BACKEND_HANDLER",
            "CCC_DEVICE_LAB_TOOL",
            "CCC_DEVICE_LAB_TOOL_ARGS",
        ]) {
            expect(text).not.toContain(forbidden);
        }
    });

    it("keeps device-lab server literal tool sets deduplicated", () => {
        const setIssues = deviceLabServerLiteralSets(false).flatMap(({ name, values }) => {
            const duplicates = values.filter((value, index) => values.indexOf(value) !== index)
                .map((value) => ({ name, value, issue: "duplicate" }));
            return duplicates;
        });
        expect(setIssues).toEqual([]);
    });

    it("keeps advertised backend enums aligned with direct and broker-supported handlers", () => {
        expect(backendAdvertisedSupportDrift()).toEqual({
            overAdvertised: [],
            underAdvertised: [],
        });
    });

    it("keeps host broker backend capabilities aligned with MCP backend capabilities", () => {
        const hostCapabilities = hostBrokerBackendCapabilities();
        const mcpCapabilities = deviceLabMcpBackendCapabilities();
        const drift = [...hostCapabilities.entries()].flatMap(([backend, hostTools]) => {
            const mcpTools = mcpCapabilities.get(backend) || [];
            return [
                ...hostTools
                    .filter((tool) => !mcpTools.includes(tool))
                    .map((tool) => ({ backend, tool, issue: "host-only" })),
                ...mcpTools
                    .filter((tool) => !hostTools.includes(tool))
                    .map((tool) => ({ backend, tool, issue: "mcp-only" })),
            ];
        });
        expect(drift).toEqual([]);
    });

    it("keeps provider real E2E scripts aligned with backend capability surfaces", () => {
        const capabilities = deviceLabMcpBackendCapabilities();
        const scripts = new Map<string, string>([
            ["android-emulator", "android-emulator-e2e.ts"],
            ["android-device", "android-device-e2e.ts"],
            ["ios-simulator", "ios-e2e.ts"],
            ["ios-device", "ios-e2e.ts"],
        ]);
        const expectedMissing = new Map<string, string[]>([
            ["android-emulator", []],
            ["android-device", []],
            ["ios-simulator", []],
            ["ios-device", ["wireless"]],
        ]);
        const drift = [...scripts.entries()].flatMap(([backend, file]) => {
            const calls = realTestCallToolNamesForFile(file);
            const missing = (capabilities.get(backend) || [])
                .filter((tool) => TOOLS.some((entry) => entry.name === tool) && !calls.has(tool))
                .sort();
            const expected = [...(expectedMissing.get(backend) || [])].sort();
            return JSON.stringify(missing) === JSON.stringify(expected)
                ? []
                : [{ backend, file, missing, expected }];
        });
        expect(drift).toEqual([]);
    });

    it("keeps broker lifecycle commands outside the advertised public tool surface", () => {
        expect(advertisedDeviceLabTools()).not.toContain("device_broker_command");
    });

    it("keeps hidden broker Appium actions and forwarded inputs explicit in the implementation", () => {
        const advertised = advertisedDeviceLabTools();
        expect(advertised).not.toContain("device_broker_appium");
        expect(brokerAppiumActionKeys()).toEqual(["clear", "delete-session", "ensure-session", "list", "record", "request", "start", "status", "stop"]);

        const forwarded = new Set(brokerAppiumForwardedInputKeys());
        expect([...forwarded]).toEqual(expect.arrayContaining([
            "backend",
            "deviceId",
            "appiumPort",
            "serverPort",
            "automationName",
            "physical",
            "method",
            "path",
            "body",
        ]));
    });

    it("keeps hidden broker RPC methods restricted to the runtime allowlist", () => {
        const advertised = advertisedDeviceLabTools();
        expect(advertised).not.toContain("device_broker_rpc");
        expect(publicBrokerRpcMethodKeys()).toEqual(["broker.backends", "broker.echo", "broker.inventory", "broker.status"]);
    });

    it("keeps newly admitted destructive flow actions guarded by per-step confirmation", () => {
        const actions = DESTRUCTIVE_POLICY_SCHEMA_EXAMPLES.filter(({ name }) => DEVICE_FLOW_TOOL_NAMES.includes(publicToolName(name)));
        expect(actions.map(({ name }) => publicToolName(name))).toEqual([
            "uninstall_app", "clear_app_data", "set_battery", "set_network",
        ]);
        for (const { name, args } of actions) {
            expect(evaluateDestructivePolicy(name, args).ok).toBe(false);
            expect(evaluateDestructivePolicy(name, { ...args, confirmDestructive: true }).ok).toBe(true);
        }
    });

    it("retains explicit double-click evidence after merging click tools", () => {
        const calls = realTestCallToolLiteralValues();
        for (const file of ["android-emulator-e2e.ts", "android-device-e2e.ts", "ios-e2e.ts", "level1-display-e2e.ts", "windows-sandbox-e2e.ts", "macos-vm-e2e.ts"]) {
            expect(calls.some(call => call.file === file && call.tool === "click" && call.values.count === 2), file).toBe(true);
        }
    });

    it("covers safe Android mobile controls in the real emulator E2E through MCP calls", () => {
        const text = readFileSync(join(repoRoot, "scripts", "real-tests", "android-emulator-e2e.ts"), "utf-8");
        expect(text).toContain('}, providerMcpSessionOptions(options, "ccc-real-android-emulator-e2e"));');
        expect(text).not.toContain('new Promise((resolvePromise) => {\n        const server = createServer();\n        server.once("error", () => resolvePromise(false));\n        server.listen(port, "127.0.0.1", () => {\n            server.close(() => resolvePromise(true));\n        });\n    }, providerMcpSessionOptions');
        for (const tool of [
            "status",
            "ui",
            "home",
            "click",
            "long_press",
            "swipe",
            "drag",
            "type",
            "key",
            "back",
            "forward",
            "recents",
            "lock",
            "unlock",
            "set_orientation",
            "set_orientation",
            "set_orientation",
            "open_url",
            "set_location",
            "set_battery",
            "permission",
            "permission",
            "wait_for_app",
            "record_video",
            "record_video",
            "record_video",
            "run_flow",
            "screenshot",
            "clipboard",
            "clipboard",
            "upload",
            "download",
            "status",
        ]) {
            expect(text).toContain(`callTool("${tool}"`);
        }
    });

    it("covers destructive Android emulator controls only through the explicit level 3 path", () => {
        const level3 = dryRunNode("3");
        expect(level3.args).toContain(join(repoRoot, "scripts", "real-tests", "level3-real-destructive.ts"));
        const destructiveText = readFileSync(join(repoRoot, "scripts", "real-tests", "level3-real-destructive.ts"), "utf-8");
        const androidText = readFileSync(join(repoRoot, "scripts", "real-tests", "android-emulator-e2e.ts"), "utf-8");
        expect(destructiveText).toContain("destructive: true");
        for (const tool of [
            "power",
            "set_network",
        ]) {
            expect(androidText).toContain(`callTool("${tool}"`);
        }
        expect(realTestCallToolLiteralValues().some(call => call.file === "android-emulator-e2e.ts"
            && call.tool === "set_network" && call.values.airplaneMode === false)).toBe(true);
    });

    it("covers Android app install, launch, app clearing, and uninstall with a deterministic fixture or configured APK", () => {
        const text = readFileSync(join(repoRoot, "scripts", "real-tests", "android-emulator-e2e.ts"), "utf-8");
        expect(text).toContain("CCC_REAL_ANDROID_APK");
        expect(text).toContain("CCC_REAL_ANDROID_PACKAGE");
        expect(text).toContain("CCC_REAL_ANDROID_PERMISSION");
        expect(text).toContain("materializeAndroidAppFixture(tempDir)");
        expect(text).toContain("appArtifact: \"verified\"");
        expect(text).toContain("appPermission: \"verified\"");
        for (const tool of [
            "install_app",
            "launch_app",
            "install_app",
            "launch_app",
            "uninstall_app",
            "clear_app_data",
            "upload",
            "download",
        ]) {
            expect(text).toContain(`callTool("${tool}"`);
        }
    });

    it("covers safe Android physical-device controls in the real-device E2E through MCP calls", () => {
        const text = readFileSync(join(repoRoot, "scripts", "real-tests", "android-device-e2e.ts"), "utf-8");
        expect(text).toContain("CCC_REAL_ANDROID_DEVICE_SERIAL");
        expect(text).toContain("use deterministic fixture");
        expect(text).toContain("prepareAndroidDeviceApp(appSelection, tempDir)");
        expect(text).toContain("wirelessCoverage: \"status-actions-device verified\"");
        expect(text).not.toContain("if (appArtifactReady)");
        expect(text.indexOf("androidDeviceE2EPrerequisites()")).toBeLessThan(text.indexOf("mkdirSync(artifactRoot"));
        for (const tool of [
            "attach",
            "status",
            "start",
            "exec",
            "status",
            "ui",
            "wait_for_text",
            "click",
            "long_press",
            "swipe",
            "drag",
            "type",
            "key",
            "home",
            "back",
            "forward",
            "recents",
            "power",
            "lock",
            "unlock",
            "set_orientation",
            "set_orientation",
            "set_orientation",
            "open_url",
            "clipboard",
            "clipboard",
            "screenshot",
            "screenshot",
            "record_video",
            "record_video",
            "record_video",
            "upload",
            "download",
            "install_app",
            "launch_app",
            "install_app",
            "launch_app",
            "wait_for_app",
            "permission",
            "permission",
            "stop_app",
            "clear_app_data",
            "uninstall_app",
            "stop",
            "detach",
        ]) {
            expect(text).toContain(`callTool("${tool}"`);
        }
        expect(text).toContain("install-launch-wait-permission-stop-clear-uninstall verified");
    });

    it("covers iOS Simulator app install, launch, app clearing, and uninstall when a disposable .app is configured", () => {
        const text = readFileSync(join(repoRoot, "scripts", "real-tests", "ios-e2e.ts"), "utf-8");
        expect(text).toContain("CCC_REAL_IOS_SIMULATOR_APP");
        expect(text).toContain("CCC_REAL_IOS_SIMULATOR_BUNDLE_ID");
        expect(text).toContain("CCC_REAL_DEVICE_LAB_FAIL_ON_SKIP");
        expect(text).toContain("missing CCC_REAL_IOS_SIMULATOR_APP/CCC_REAL_IOS_SIMULATOR_BUNDLE_ID");
        expect(text).toContain("missing iOS Appium/XCUITest prerequisites");
        for (const tool of [
            "install_app",
            "launch_app",
            "install_app",
            "launch_app",
            "uninstall_app",
            "clear_app_data",
        ]) {
            expect(text).toContain(`callTool("${tool}"`);
        }
    });

    it("rejects incomplete Android app proof before physical-device mutation", () => {
        expect(androidDeviceE2EPrerequisites({
            CCC_REAL_ANDROID_DEVICE_APK: "missing.apk",
            CCC_REAL_ANDROID_DEVICE_PACKAGE: "dev.ccc.fixture",
        })).toEqual(expect.objectContaining({
            available: false,
            reason: expect.stringContaining("CCC_REAL_ANDROID_DEVICE_PERMISSION"),
        }));
    });

    it("uses the signed fixture when no physical Android app inputs are supplied", () => {
        expect(androidDeviceE2EPrerequisites({})).toEqual(expect.objectContaining({
            available: true,
            source: "fixture",
            app: null,
        }));
    });

    it("preserves physical Android external-app aliases and cleans failed fixture materialization", () => {
        const tempDir = mkdtempSync(join(tmpdir(), "ccc-android-device-selection-"));
        const apk = join(tempDir, "external.apk");
        writeFileSync(apk, "fixture");
        try {
            for (const env of [
                { CCC_REAL_ANDROID_DEVICE_APK: apk, CCC_REAL_ANDROID_DEVICE_PACKAGE: "dev.external", CCC_REAL_ANDROID_DEVICE_PERMISSION: "android.permission.CAMERA" },
                { CCC_REAL_ANDROID_APK: apk, CCC_REAL_ANDROID_PACKAGE: "dev.external", CCC_REAL_ANDROID_PERMISSION: "android.permission.CAMERA" },
                { CCC_REAL_DEVICE_LAB_ANDROID_DEVICE_APK: apk, CCC_REAL_DEVICE_LAB_ANDROID_DEVICE_PACKAGE: "dev.external", CCC_REAL_DEVICE_LAB_ANDROID_DEVICE_PERMISSION: "android.permission.CAMERA" },
            ]) {
                expect(androidDeviceE2EPrerequisites(env)).toEqual(expect.objectContaining({
                    available: true,
                    source: "external",
                    app: expect.objectContaining({ path: apk, packageName: "dev.external" }),
                }));
            }
        } finally {
            rmSync(tempDir, { recursive: true, force: true });
        }

        const failedTemp = mkdtempSync(join(tmpdir(), "ccc-android-device-fixture-failure-"));
        expect(() => prepareAndroidDeviceApp({ source: "fixture", app: null }, failedTemp, () => {
            throw new Error("fixture failure");
        })).toThrow("fixture failure");
        expect(existsSync(failedTemp)).toBe(false);
    });

    it("uses the emulator fixture only when no external app inputs were supplied", () => {
        expect(androidEmulatorAppSelection({})).toEqual(expect.objectContaining({
            available: true,
            source: "fixture",
        }));
        expect(androidEmulatorAppSelection({ CCC_REAL_ANDROID_APK: "partial.apk" })).toEqual(expect.objectContaining({
            available: false,
            source: "external",
            reason: expect.stringContaining("CCC_REAL_ANDROID_PACKAGE"),
        }));

        const tempDir = mkdtempSync(join(tmpdir(), "ccc-android-selection-"));
        const apk = join(tempDir, "fixture.apk");
        writeFileSync(apk, "fixture");
        try {
            expect(androidEmulatorAppSelection({
                CCC_REAL_ANDROID_APK: apk,
                CCC_REAL_ANDROID_PACKAGE: "dev.ccc.fixture",
                CCC_REAL_ANDROID_PERMISSION: "android.permission.CAMERA",
            })).toEqual(expect.objectContaining({
                available: true,
                source: "external",
                app: expect.objectContaining({ path: apk }),
            }));
        } finally {
            rmSync(tempDir, { recursive: true, force: true });
        }

        const emulatorText = readFileSync(join(repoRoot, "scripts", "real-tests", "android-emulator-e2e.ts"), "utf-8");
        expect(emulatorText.indexOf("androidEmulatorAppSelection()")).toBeLessThan(emulatorText.indexOf("mkdtempSync("));
    });

    it("preserves broker command failure details in Android real-test assertions", () => {
        expect(() => deviceFromPayload({
            ok: false,
            error: "provider-command-failed",
            detail: "stderr: Error: Package path is not valid. Valid system image paths are:",
        }, "create")).toThrow(
            "create returned no device: provider-command-failed: stderr: Error: Package path is not valid. Valid system image paths are:",
        );
    });

    it("preserves Android real-test device extraction and legacy diagnostics", () => {
        const device = { id: "android-real-test" };
        expect(deviceFromPayload({ device }, "create")).toBe(device);
        expect(() => deviceFromPayload({
            launch: { error: "launch-failed", detail: "emulator exited", command: "emulator" },
            attempts: [{ error: "boot-timeout" }],
        }, "start")).toThrow("start returned no device: launch-failed: emulator exited: emulator: boot-timeout");
        expect(() => deviceFromPayload({}, "create")).toThrow("create returned no device (keys: none)");
        expect(() => deviceFromPayload({ ok: false }, "create")).toThrow("create returned no device (keys: ok)");
    });

    it("delegates real Android emulator port allocation to the broker", () => {
        const request = androidEmulatorCreateRequest({
            name: "Port Allocated Pixel",
            deviceId: "android-port-allocated",
            systemImage: "system-images;android-35;google_apis;x86_64",
        });
        expect(request).toEqual({
            name: "Port Allocated Pixel",
            deviceId: "android-port-allocated",
            systemImage: "system-images;android-35;google_apis;x86_64",
        });
        expect(request).not.toHaveProperty("port");
    });

    it("covers safe iOS Simulator mobile controls in the real simulator E2E through MCP calls", () => {
        const text = readFileSync(join(repoRoot, "scripts", "real-tests", "ios-e2e.ts"), "utf-8");
        for (const tool of [
            "status",
            "ui",
            "click",
            "long_press",
            "swipe",
            "drag",
            "home",
            "lock",
            "unlock",
            "set_orientation",
            "set_orientation",
            "set_orientation",
            "screenshot",
            "open_url",
            "stop_app",
            "set_location",
            "permission",
            "permission",
            "clipboard",
            "clipboard",
            "wait_for_app",
            "record_video",
            "record_video",
            "record_video",
            "status",
        ]) {
            expect(text).toContain(`callTool("${tool}"`);
        }
        expect(text).toContain("waitForSafari.running");
        expect(text).toContain("waitForInstalledApp.running");
    });

    it("covers safe iOS physical-device Appium controls in the real-device E2E through MCP calls", () => {
        const text = readFileSync(join(repoRoot, "scripts", "real-tests", "ios-e2e.ts"), "utf-8");
        expect(text).toContain("CCC_REAL_IOS_DEVICE_BUNDLE_ID");
        expect(text).toContain("CCC_REAL_DEVICE_LAB_FAIL_ON_SKIP");
        expect(text).toContain("missing iOS real-device Appium/XCUITest prerequisites");
        for (const tool of [
            "status",
            "ui",
            "screenshot",
            "click",
            "long_press",
            "swipe",
            "drag",
            "type",
            "key",
            "home",
            "lock",
            "unlock",
            "set_orientation",
            "set_orientation",
            "set_orientation",
            "wait_for_text",
            "install_app",
            "launch_app",
            "wait_for_app",
            "stop_app",
        ]) {
            expect(text).toContain(`callTool("${tool}"`);
        }
        expect(text).toContain("appiumControls = \"verified\"");
        expect(text).toContain("appCoverage = appArtifactReady ? \"install-launch-wait-stop verified\" : \"launch-wait-stop verified\"");
    });

    it("covers macOS VM snapshot restore in the destructive real E2E path", () => {
        const text = readFileSync(join(repoRoot, "scripts", "real-tests", "macos-vm-e2e.ts"), "utf-8");
        const snapshotActions = realTestCallToolLiteralValues()
            .filter(call => call.file === "macos-vm-e2e.ts" && call.tool === "snapshot")
            .map(call => call.values.action);
        expect(snapshotActions).toEqual(expect.arrayContaining(["create", "restore", "delete"]));
        expect(text).toContain("typedOptions.snapshot === true");
    });

    it("covers the current X11 display tools in a real MCP E2E", () => {
        const level1 = dryRunNode("1");
        expect(level1.args).toContain(join(repoRoot, "scripts", "real-tests", "level1-display-e2e.ts"));
        const text = readFileSync(join(repoRoot, "scripts", "real-tests", "level1-display-e2e.ts"), "utf-8");
        for (const tool of [
            "status",
            "screenshot",
            "click",
            "key",
            "type",
            "scroll",
            "cursor_position",
            "devices",
            "status",
            "screenshot",
            "click",
            "key",
            "type",
            "scroll",
            "cursor_position",
            "run_flow",
        ]) {
            expect(text).toContain(`"${tool}"`);
        }
        expect(text).toContain("withDeviceLabMcp");
        expect(text).toContain("\"left\", \"right\"");
        expect(text).toContain("\"up\", \"down\", \"left\", \"right\"");
        expect(text).toContain("devices includes current display");
        expect(text).toContain("status current display alias");
        expect(text).toContain("cursor_position current display alias");
        expect(text).toContain("click buttons");
        expect(text).toContain("double_click buttons");
        expect(text).toContain("scroll directions");
        expect(text).toContain("click current display alias buttons");
        expect(text).toContain("double_click current display alias buttons");
        expect(text).toContain("scroll current display alias directions");
    });

    it("reports an unavailable current display E2E as skipped at both levels", () => {
        expect(currentDisplayPrerequisiteResult(["xdotool", "scrot"])).toEqual({
            status: "SKIP",
            reason: "missing xdotool, scrot",
            steps: [{
                name: "current display prerequisites",
                status: "SKIP",
                reason: "missing xdotool, scrot",
            }],
        });
    });

    it("covers safe desktop read-only tools in Windows and macOS real E2E through MCP calls", () => {
        for (const file of ["windows-sandbox-e2e.ts", "macos-vm-e2e.ts"]) {
            const text = readFileSync(join(repoRoot, "scripts", "real-tests", file), "utf-8");
            for (const tool of [
                "click",
                "key",
                "type",
                "scroll",
                "window_list",
                "cursor_position",
                "ui",
                "record_video",
            ]) {
                expect(text).toContain(`callTool("${tool}"`);
            }
        }
        const windowsText = readFileSync(join(repoRoot, "scripts", "real-tests", "windows-sandbox-e2e.ts"), "utf-8");
        expect(windowsText).toContain("status.device.sandboxId");
        expect(windowsText).toContain("upload.uploaded.remotePath");
        expect(windowsText).toContain("download.downloaded.localPath");

        const macosText = readFileSync(join(repoRoot, "scripts", "real-tests", "macos-vm-e2e.ts"), "utf-8");
        expect(macosText).toContain("upload.provider");
        expect(macosText).toContain("download.provider");
        expect(macosText).toContain("upload.uploaded.remotePath");
        expect(macosText).toContain("download.downloaded.localPath");
    });

    it("covers physical wireless status and safe action diagnostics in real MCP readiness", () => {
        const text = readFileSync(join(repoRoot, "scripts", "real-tests", "level1-real-provider-readiness.ts"), "utf-8");
        expect(text).toContain("wireless");
        expect(text).toContain("action: \"status\"");
        expect(text).toContain("markExpectedInputError");
        expect(text).toContain("android-wireless-missing-adb");
        expect(text).toContain("wireless usb-tcpip requires serial");
        expect(text).toContain("wireless pair requires pairHost, pairPort and pairingCode");
        expect(text).toContain("wireless connect requires host or serial");
        expect(text).toContain("iOS wireless supports only action:status");
        expect(text).toContain("Android physical wireless action diagnostics MCP");
        expect(text).toContain("iOS physical wireless action diagnostics MCP");
    });

    it("keeps backend enum diagnostic probes schema-valid across physical providers", () => {
        const probes = backendProviderEnumDiagnostics({ brokerPort: 17373, port: 17373, detail: true });
        const physical = probes.filter(([tool]) => tool === "attach" || tool === "wireless");
        expect(physical).toHaveLength(4);
        for (const [tool, args] of physical) {
            expect(toolInputError(tool, args), `${tool}:${args.backend}`).toBeNull();
            expect(args.brokerPort).toBe(17373);
            const publicArgs = Object.fromEntries(Object.entries(args)
                .filter(([key]) => !HIDDEN_LEGACY_TRANSPORT_KEYS.has(key)));
            expect(new Ajv({ strict: false }).compile(TOOLS.find(t => t.name === tool)!.inputSchema)(publicArgs)).toBe(true);
        }
        const iosAttach = physical.find(([tool, args]) => tool === "attach" && args.backend === "ios-device")![1];
        expect(iosAttach.udid).toBe("00000000-0000000000000000");
        expect(iosAttach).not.toHaveProperty("serial");
        for (const [tool, args] of physical) if (tool === "wireless") expect(args).not.toHaveProperty("port");
    });

    it("sends a valid missing-image create probe without confusing broker and device ports", () => {
        const request = missingWindowsImageProbe({
            detail: true, autolaunch: true, port: 17373, brokerPort: 17373,
            hostCandidates: ["127.0.0.1"], timeoutMs: 1000,
            rpcTimeoutMs: 10000, launchTimeoutMs: 5000,
        });
        expect(request).not.toHaveProperty("port");
        expect(request).not.toHaveProperty("deviceId");
        expect(request).toHaveProperty("dryRun", true);
        expect(request).toMatchObject({ brokerPort: 17373, image: "ccc-level2-missing-image" });
        expect(toolInputError("create_windows_vm", request)).toBeNull();
        const publicArgs = Object.fromEntries(Object.entries(request)
            .filter(([key]) => !HIDDEN_LEGACY_TRANSPORT_KEYS.has(key)));
        const schema = TOOLS.find(tool => tool.name === "create_windows_vm")!.inputSchema;
        expect(new Ajv({ strict: false }).compile(schema)(publicArgs)).toBe(true);
        expect(toolInputError("create_windows_vm", { ...request, port: 17373 }))
            .toBe("create windows-vm does not support port");
    });

    it("proves missing macOS image failure leaves owner inventory unchanged without selecting a made-up ID", async () => {
        const existing = { deviceId: "macos-vm-13579bdf-2468-4ace-8bdf-13579bdf2468", name: "existing fixture" };
        const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
        const createRecord = { expectedError: false };
        await probeMissingMacosImage(async (tool, args) => {
            calls.push({ tool, args });
            return tool === "create_macos_vm"
                ? { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "macos-tart-clone-failed", image: "missing-source" }) }], __cccToolCallRecord: createRecord }
                : { content: [{ type: "text", text: JSON.stringify({ devices: [existing] }) }] };
        });
        expect(calls.map(call => call.tool)).toEqual(["devices", "create_macos_vm", "devices"]);
        expect(calls[1].args).toMatchObject({ image: "missing-source" });
        expect(calls[1].args).not.toHaveProperty("deviceId");
        expect(calls.every(call => !("incarnationId" in call.args))).toBe(true);
        expect(createRecord.expectedError).toBe(true);
    });

    it("rejects deferred macOS image creation that publishes a definition", async () => {
        const calls: string[] = [];
        await expect(probeMissingMacosImage(async (tool) => {
            calls.push(tool);
            return { content: [{ type: "text", text: JSON.stringify(tool === "devices"
                ? { devices: [] } : { device: { deviceId: "macos-2468ace0-1357-4bdf-8ace-2468ace01357", status: "stopped" } }) }] };
        })).rejects.toThrow("missing image unexpectedly cloned during create");
        expect(calls).toEqual(["devices", "create_macos_vm"]);
    });

    it("rejects failed macOS image creation that publishes any new generated ID", async () => {
        let inventories = 0;
        await expect(probeMissingMacosImage(async (tool) => tool === "create_macos_vm"
            ? { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "macos-tart-clone-failed" }) }] }
            : { content: [{ type: "text", text: JSON.stringify({ devices: ++inventories === 1 ? [] : [
                { deviceId: "macos-abcdef12-3456-4789-8abc-def123456789", name: "Level 2 public missing base image", status: "stopped" },
            ] }) }] })).rejects.toThrow(/published|inventory|unpublished/);
        expect(inventories).toBe(2);
    });

    it.each(["Unexpected error: provider dispatch threw", "Unknown tool: create_macos_vm", "permission denied"])("rejects unrelated macOS image probe errors (%s)", async (diagnostic) => {
        await expect(probeMissingMacosImage(async (tool) => tool === "devices"
            ? { content: [{ type: "text", text: JSON.stringify({ devices: [] }) }] }
            : { isError: true, content: [{ type: "text", text: diagnostic }] }
        )).rejects.toThrow();
    });

    it.each([{}, { devices: null }, { ok: false, error: "host-broker-unavailable" }])("fails closed when missing-image inventory is invalid (%j)", async (inventory) => {
        const creates: string[] = [];
        await expect(probeMissingMacosImage(async (tool) => {
            if (tool === "create_macos_vm") creates.push(tool);
            return { content: [{ type: "text", text: JSON.stringify(inventory) }] };
        })).rejects.toThrow();
        expect(creates).toEqual([]);
    });

    it("runs available real-provider E2E scenarios through source and packaged MCP servers", () => {
        const matrixText = readFileSync(join(repoRoot, "scripts", "real-tests", "provider-mcp-matrix.ts"), "utf-8");
        const readinessText = readFileSync(join(repoRoot, "scripts", "real-tests", "level1-dist-real-provider-readiness.ts"), "utf-8");
        const coreFiles = [
            "android-emulator-e2e.ts",
            "android-device-e2e.ts",
            "ios-e2e.ts",
            "macos-vm-e2e.ts",
            "windows-sandbox-e2e.ts",
        ];
        const levelFiles = [
            "level2-android-emulator-e2e.ts",
            "level2-android-device-e2e.ts",
            "level2-ios-e2e.ts",
            "level2-macos-vm-e2e.ts",
            "level2-windows-sandbox.ts",
            "level3-real-destructive.ts",
        ];

        expect(matrixText).toContain("packagedDeviceLabMcpServer");
        expect(matrixText).not.toContain("CCC_REAL_DEVICE_LAB_SOURCE_MATRIX");
        expect(matrixText).not.toContain("ccc-real-provider-source-mcp-e2e");
        expect(matrixText).toContain("serverPath: packagedDeviceLabMcpServer");
        expect(readinessText).toContain("packagedDeviceLabMcpServer");
        for (const file of coreFiles) {
            expect(readFileSync(join(repoRoot, "scripts", "real-tests", file), "utf-8")).toContain("providerMcpSessionOptions(options");
        }
        for (const file of levelFiles) {
            expect(readFileSync(join(repoRoot, "scripts", "real-tests", file), "utf-8")).toContain("runProviderMcpMatrix");
        }
    });

    it("runs each expensive real provider exactly once through the packaged MCP", async () => {
        const { runProviderMcpMatrix } = await import("../../scripts/real-tests/provider-mcp-matrix.ts") as {
            runProviderMcpMatrix: (runner: (options: Record<string, unknown>) => Promise<Record<string, unknown>>) => Promise<Record<string, unknown>>;
        };
        const calls: Array<Record<string, unknown>> = [];
        const scenario = async (options: Record<string, unknown>) => {
            calls.push(options);
            return { status: "PASS" };
        };
        await runProviderMcpMatrix(scenario);
        expect(calls).toHaveLength(1);
        expect(String(calls[0].serverPath)).toContain("dist");
    });

    it("preserves all-skipped provider matrices instead of reporting a false pass", async () => {
        const { runProviderMcpMatrix } = await import("../../scripts/real-tests/provider-mcp-matrix.ts") as {
            runProviderMcpMatrix: (runner: (options: Record<string, unknown>) => Promise<Record<string, unknown>>) => Promise<Record<string, unknown>>;
        };

        const skipped = await runProviderMcpMatrix(async () => ({ status: "SKIP", reason: "not this host" }));
        expect(skipped).toEqual(expect.objectContaining({ status: "SKIP", reason: "not this host" }));

        const mixed = await runProviderMcpMatrix(async () => ({
            status: "PASS",
            steps: [
                { name: "available", status: "PASS" },
                { name: "optional", status: "SKIP", reason: "missing hardware" },
            ],
        }));
        expect(mixed).toEqual(expect.objectContaining({ status: "PASS" }));

        const failed = await runProviderMcpMatrix(async () => ({ status: "FAIL", reason: "provider failed" }));
        expect(failed).toEqual(expect.objectContaining({ status: "FAIL" }));
    });

    it("aggregates real-test steps without false passes", async () => {
        const { aggregateStepResult } = await import("../../scripts/real-tests/result-status.ts") as {
            aggregateStepResult: (steps: Array<Record<string, unknown>>) => Record<string, unknown>;
        };

        expect(aggregateStepResult([
            { name: "unsupported-a", status: "SKIP", reason: "not this host" },
            { name: "unsupported-b", status: "SKIP", reason: "missing hardware" },
        ])).toEqual({ status: "SKIP", reason: "not this host; missing hardware" });
        expect(aggregateStepResult([
            { name: "available", status: "PASS" },
            { name: "optional", status: "SKIP" },
        ])).toEqual({ status: "PASS" });
        expect(aggregateStepResult([{ name: "broken", status: "FAIL" }])).toEqual({ status: "FAIL" });
        expect(aggregateStepResult([])).toEqual({ status: "FAIL", reason: "test returned no result steps" });
        expect(aggregateStepResult([{ name: "malformed", status: "UNKNOWN" }])).toEqual({
            status: "FAIL",
            reason: "test returned invalid step status: malformed",
        });
    });

    it("keeps real E2E tool coverage explicit for every advertised device-lab MCP tool", () => {
        const calledTools = realTestCallToolNames();
        const advertised = advertisedDeviceLabTools();
        const intentionallyNotSafeInGenericRealE2E: string[] = [];
        const missing = advertised.filter((tool) => !calledTools.has(tool));
        const unadvertised = [...calledTools].filter((tool) => !advertised.includes(tool));
        expect(missing).toEqual(intentionallyNotSafeInGenericRealE2E);
        expect(unadvertised).toEqual([]);
    });

    it("keeps provider real E2E scripts on advertised public device-lab tools", () => {
        const hiddenProviderCalls = realTestCallToolArgumentKeys()
            .filter((call) => call.file !== "level2-broker-e2e.ts")
            .filter((call) => !TOOLS.some((tool) => tool.name === call.tool));
        expect(hiddenProviderCalls).toEqual([]);
    });

    it("keeps provider real E2E scripts free of hidden broker transport arguments", () => {
        const hiddenProviderArgs = realTestCallToolArgumentKeys()
            .filter((call) => call.file !== "level2-broker-e2e.ts")
            .filter((call) => !OPT_IN_REAL_TEST_UTILITY_FILES.has(call.file))
            .flatMap((call) => call.keys
                .filter((key) => HIDDEN_PROVIDER_REAL_E2E_TRANSPORT_KEYS.has(key))
                .map((key) => ({ file: call.file, tool: call.tool, hidden: key })));
        expect(hiddenProviderArgs).toEqual([]);
    });

    it("keeps broker transport knobs hidden from advertised device-lab MCP schemas", () => {
        const schemas = advertisedDeviceLabToolSchemas();
        const hiddenTransportKeys = [...HIDDEN_LEGACY_TRANSPORT_KEYS].filter((key) => key !== "port" && key !== "timeoutMs");
        const exposed = [...schemas.entries()].flatMap(([tool, properties]) => hiddenTransportKeys
            .filter((key) => properties.has(key))
            .map((key) => ({ tool, key })));
        expect(exposed).toEqual([]);
    });

    it("keeps real E2E MCP call arguments aligned with advertised input schemas", () => {
        const schemas = advertisedDeviceLabToolSchemas();
        const unknownKeys = realTestCallToolArgumentKeys().flatMap((call) => {
            const properties = schemas.get(call.tool);
            if (!properties) return [{ file: call.file, tool: call.tool, unknown: "<unadvertised-tool>" }];
            return call.keys
                .filter((key) => !properties.has(key) && !HIDDEN_LEGACY_TRANSPORT_KEYS.has(key))
                .map((key) => ({ file: call.file, tool: call.tool, unknown: key }));
        });
        expect(unknownKeys).toEqual([]);
        expect(realTestCallsMissingAnyOfRequired()).toEqual([]);
    });

    it("keeps real E2E MCP literal enum values aligned with advertised input schemas", () => {
        const enumSchemas = advertisedDeviceLabToolEnums();
        const invalidValues = realTestCallToolLiteralValues().flatMap((call) => {
            const enums = enumSchemas.get(call.tool) || {};
            return Object.entries(call.values)
                .filter(([key, value]) => Array.isArray(enums[key]) && typeof value === "string" && !enums[key].includes(value))
                .map(([key, value]) => ({ file: call.file, tool: call.tool, key, value, allowed: enums[key] }));
        });
        expect(invalidValues).toEqual([]);
    });

    it("keeps destructive real E2E MCP calls explicitly confirmed", () => {
        expect([...ALWAYS_DESTRUCTIVE_REAL_E2E_TOOLS].sort()).toEqual(expect.arrayContaining(alwaysDestructivePolicyTools().filter(tool => tool === "device_broker_shutdown" || TOOLS.some(entry => entry.name === tool))));
        expect(realTestDestructiveCallsMissingConfirmation()).toEqual([]);
    });

    it("keeps every real E2E MCP call reachable from the level 3 node runner", () => {
        const plan = dryRunNode("3");
        const entryFiles = plan.args
            .filter((arg) => dirname(arg) === join(repoRoot, "scripts", "real-tests") && arg.endsWith(".ts"))
            .map((arg) => basename(arg))
            .filter((file) => file !== "run.ts");
        const reachable = reachableRealTestFilesFrom(entryFiles);
        const unreachableCallToolFiles = realTestFilesWithCallTool()
            .filter((file) => !OPT_IN_REAL_TEST_UTILITY_FILES.has(file))
            .filter((file) => !reachable.has(file));
        expect(unreachableCallToolFiles).toEqual([]);
    });

    it("keeps every generic-real-E2E exclusion covered by focused contract tests", () => {
        const text = testSupportText();
        const intentionallyNotSafeInGenericRealE2E: string[] = [];

        const uncovered = intentionallyNotSafeInGenericRealE2E.filter((tool) => {
            const pattern = new RegExp(`(?:name|tool|compatibilityTool):\\s*["']${tool}["']|\\[["']${tool}["']|(?:callTool|handle[A-Za-z]*Tool)\\(["']${tool}["']|${tool}:\\s*\\{`);
            return !pattern.test(text);
        });
        expect(uncovered).toEqual([]);
    });

    it("fails the self-contained node runner when any step fails", { timeout: 60000 }, () => {
        const tempDir = mkdtempSync(join(tmpdir(), "ccc-real-test-runner-"));
        try {
            const passFile = join(tempDir, "pass.mjs");
            const stepFailFile = join(tempDir, "step-fail.mjs");
            const multilineFailFile = join(tempDir, "multiline-fail.mjs");
            writeFileSync(passFile, "export const name='pass'; export async function run(){ return { status: 'PASS', detail: 'provider=tart' }; }\n");
            writeFileSync(stepFailFile, "export const name='step-fail'; export async function run(){ return { status: 'FAIL', steps: [{ name: 'inner', status: 'FAIL', reason: 'boom', detail: 'device=abc' }] }; }\n");
            writeFileSync(multilineFailFile, "export const name='multiline-fail'; export async function run(){ throw new Error('Expected values to be strictly equal:\\n+ actual\\n- expected'); }\n");

            const result = spawnSync(process.execPath, ["--import", repoLoader, join(repoRoot, "scripts", "real-tests", "run.ts"), passFile, stepFailFile], {
                cwd: repoRoot,
                encoding: "utf-8",
            });

            expect(result.status).toBe(1);
            expect(result.stdout).toContain("PASS pass (provider=tart)");
            expect(result.stdout).toContain("FAIL step-fail: inner - boom (device=abc)");
            expect(result.stdout).toContain("SUMMARY real-tests total=2 pass=1 skip=0 fail=1 failOnSkip=false");
            expect(result.stdout).not.toContain("strictSkipFailures");

            const compactResult = spawnSync(process.execPath, ["--import", repoLoader, join(repoRoot, "scripts", "real-tests", "run.ts"), "--compact", passFile, stepFailFile], {
                cwd: repoRoot,
                encoding: "utf-8",
            });
            expect(compactResult.status).toBe(1);
            expect(compactResult.stdout).not.toContain("PASS pass");
            expect(compactResult.stdout).toContain("FAIL step-fail: inner - boom");
            expect(compactResult.stdout).toContain("SUMMARY real-tests total=2 pass=1 skip=0 fail=1 failOnSkip=false");

            const multilineResult = spawnSync(process.execPath, ["--import", repoLoader, join(repoRoot, "scripts", "real-tests", "run.ts"), "--compact", multilineFailFile], {
                cwd: repoRoot,
                encoding: "utf-8",
            });
            expect(multilineResult.status).toBe(1);
            expect(multilineResult.stderr).toContain("FAIL multiline-fail - Expected values to be strictly equal: + actual - expected");
        } finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it("fails closed when real-test results omit or invent statuses", () => {
        const tempDir = mkdtempSync(join(tmpdir(), "ccc-real-test-runner-"));
        writeFileSync(join(tempDir, "package.json"), JSON.stringify({ type: "module" }));
        try {
            const missingResultStatus = join(tempDir, "missing-result-status.ts");
            const invalidStepStatus = join(tempDir, "invalid-step-status.mjs");
            const nullStep = join(tempDir, "null-step.mjs");
            const inconsistentParent = join(tempDir, "inconsistent-parent.mjs");
            const emptySteps = join(tempDir, "empty-steps.mjs");
            writeFileSync(missingResultStatus, "export const name='missing-result'; export async function run(){ return { detail: 'no status' }; }\n");
            writeFileSync(invalidStepStatus, "export const name='invalid-step'; export async function run(){ return { status: 'PASS', steps: [{ name: 'inner', status: 'UNKNOWN' }] }; }\n");
            writeFileSync(nullStep, "export const name='null-step'; export async function run(){ return { status: 'PASS', steps: [null] }; }\n");
            writeFileSync(inconsistentParent, "export const name='inconsistent-parent'; export async function run(){ return { status: 'PASS', steps: [{ name: 'unsupported', status: 'SKIP', reason: 'not this host' }] }; }\n");
            writeFileSync(emptySteps, "export const name='empty-steps'; export async function run(){ return { status: 'PASS', steps: [] }; }\n");

            const result = spawnSync(process.execPath, [
                "--import", repoLoader,
                join(repoRoot, "scripts", "real-tests", "run.ts"),
                "--compact",
                missingResultStatus,
                invalidStepStatus,
                nullStep,
                inconsistentParent,
                emptySteps,
            ], { cwd: repoRoot, encoding: "utf-8" });

            expect(result.status).toBe(1);
            expect(result.stdout).toContain("FAIL missing-result - invalid or missing result status: undefined");
            expect(result.stdout).toContain('FAIL invalid-step: inner - invalid or missing step status: "UNKNOWN"');
            expect(result.stdout).toContain("FAIL null-step: unnamed step - invalid or missing step status: undefined");
            expect(result.stdout).toContain("FAIL inconsistent-parent: validates parent result status - parent result status PASS disagrees with child aggregate SKIP");
            expect(result.stdout).toContain("FAIL empty-steps: validates parent result status - result returned an empty step list");
            expect(result.stdout).toContain("SUMMARY real-tests total=6 pass=0 skip=1 fail=5 failOnSkip=false");
        } finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it("can fail the self-contained node runner when any result or step skips", { timeout: 60000 }, () => {
        const tempDir = mkdtempSync(join(tmpdir(), "ccc-real-test-runner-"));
        try {
            const skipFile = join(tempDir, "skip.mjs");
            const stepSkipFile = join(tempDir, "step-skip.mjs");
            writeFileSync(skipFile, "export const name='skip'; export async function run(){ return { status: 'SKIP', reason: 'missing provider' }; }\n");
            writeFileSync(stepSkipFile, "export const name='step-skip'; export async function run(){ return { status: 'SKIP', steps: [{ name: 'inner', status: 'SKIP', reason: 'missing device' }] }; }\n");

            const defaultResult = spawnSync(process.execPath, ["--import", repoLoader, join(repoRoot, "scripts", "real-tests", "run.ts"), skipFile, stepSkipFile], {
                cwd: repoRoot,
                encoding: "utf-8",
            });
            expect(defaultResult.status).toBe(0);
            expect(defaultResult.stdout).toContain("SUMMARY real-tests total=2 pass=0 skip=2 fail=0 failOnSkip=false");
            expect(defaultResult.stdout).not.toContain("strictSkipFailures");
            expect(defaultResult.stdout).not.toContain("strictCoverageFailures");

            const strictResult = spawnSync(process.execPath, ["--import", repoLoader, join(repoRoot, "scripts", "real-tests", "run.ts"), "--compact", "--fail-on-skip", skipFile, stepSkipFile], {
                cwd: repoRoot,
                encoding: "utf-8",
            });
            expect(strictResult.status).toBe(1);
            expect(strictResult.stdout).toContain("SKIP skip - missing provider");
            expect(strictResult.stdout).toContain("SKIP step-skip: inner - missing device");
            expect(strictResult.stdout).toContain("SUMMARY real-tests total=2 pass=0 skip=2 fail=0 failOnSkip=true strictSkipFailures=2");
            expect(strictResult.stdout).not.toContain("strictCoverageFailures");
        } finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it("does not require scripted MCP facets from fully skipped real-test modules", () => {
        const tempDir = mkdtempSync(join(tmpdir(), "ccc-real-test-skipped-scripted-"));
        try {
            const skippedFile = join(tempDir, "skipped.mjs");
            const summaryFile = join(tempDir, "summary.json");
            writeFileSync(skippedFile, [
                "export const name='skipped-scripted';",
                "export async function run(){",
                "  const skipped = () => callTool(\"set_battery\", { backend: \"android-emulator\", deviceId: \"skipped-device\", level: 77, charging: true, confirmDestructive: true });",
                "  void skipped;",
                "  return { status: 'SKIP', reason: 'missing adb, emulator' };",
                "}",
                "",
            ].join("\n"));

            const result = spawnSync(process.execPath, ["--import", repoLoader, join(repoRoot, "scripts", "real-tests", "run.ts"), "--json-summary-file", summaryFile, skippedFile], {
                cwd: repoRoot,
                encoding: "utf-8",
            });
            expect(result.status).toBe(0);
            const summary = JSON.parse(readFileSync(summaryFile, "utf-8")) as {
                host: { platform: string; arch: string; node: string };
                toolCoverage: {
                    scriptedTools: string[];
                    scriptedArgumentFacets: string[];
                    invalidScriptedArgumentFacets: string[];
                    uncalledScriptedArgumentFacets: string[];
                };
            };
            expect(summary.host).toEqual({ platform: process.platform, arch: process.arch, node: process.version });
            expect(summary.toolCoverage.scriptedTools).toEqual([]);
            expect(summary.toolCoverage.scriptedArgumentFacets).toEqual([]);
            expect(summary.toolCoverage.invalidScriptedArgumentFacets).toEqual([]);
            expect(summary.toolCoverage.uncalledScriptedArgumentFacets).toEqual([]);
        } finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it("can fail the self-contained node runner on strict MCP tool coverage gaps", { timeout: 60000 }, () => {
        const tempDir = mkdtempSync(join(tmpdir(), "ccc-real-test-coverage-"));
        try {
            const scriptedButUncalledFile = join(tempDir, "scripted-gap.mjs");
            writeFileSync(scriptedButUncalledFile, [
                "export const name='scripted-gap';",
                "export async function run(){",
                "  const never = () => callTool(\"devices\", { backend: \"android-emulator\" });",
                "  void never;",
                "  return { status: 'PASS', tools: ['devices'] };",
                "}",
                "",
            ].join("\n"));

            const defaultResult = spawnSync(process.execPath, ["--import", repoLoader, join(repoRoot, "scripts", "real-tests", "run.ts"), scriptedButUncalledFile], {
                cwd: repoRoot,
                encoding: "utf-8",
            });
            expect(defaultResult.status).toBe(0);
            expect(defaultResult.stdout).toContain("SUMMARY real-tests total=1 pass=1 skip=0 fail=0 failOnSkip=false");
            expect(defaultResult.stdout).not.toContain("strictCoverageFailures");

            const strictResult = spawnSync(process.execPath, ["--import", repoLoader, join(repoRoot, "scripts", "real-tests", "run.ts"), "--fail-on-coverage-gap", scriptedButUncalledFile], {
                cwd: repoRoot,
                encoding: "utf-8",
            });
            expect(strictResult.status).toBe(1);
            expect(strictResult.stdout).toContain(`SUMMARY real-tests total=1 pass=1 skip=0 fail=0 failOnSkip=false strictCoverageFailures=${TOOLS.length + 1}`);
        } finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it("records boolean and numeric MCP argument facets in proof summaries", () => {
        const tempDir = mkdtempSync(join(tmpdir(), "ccc-real-test-boolean-facets-"));
        try {
            const facetFile = join(tempDir, "boolean-facets.mjs");
            const summaryFile = join(tempDir, "summary.json");
            writeFileSync(facetFile, [
                "export const name='boolean-facets';",
                "export async function run(){",
                "  const scripted = () => callTool(\"set_battery\", { backend: \"android-emulator\", deviceId: \"facet-device\", level: 42, status: 2, charging: true, confirmDestructive: true });",
                "  void scripted;",
                "  const key = Symbol.for('ccc.deviceLabRealTests.toolCalls');",
                "  globalThis[key] = [{ name: 'set_battery', arguments: { backend: 'android-emulator', deviceId: 'facet-device', level: 42, status: 2, charging: true, confirmDestructive: true }, outcome: 'ok', isError: false }];",
                "  return { status: 'PASS' };",
                "}",
                "",
            ].join("\n"));

            const result = spawnSync(process.execPath, ["--import", repoLoader, join(repoRoot, "scripts", "real-tests", "run.ts"), "--json-summary-file", summaryFile, facetFile], {
                cwd: repoRoot,
                encoding: "utf-8",
            });
            expect(result.status).toBe(0);
            const summary = JSON.parse(readFileSync(summaryFile, "utf-8")) as {
                toolCoverage: {
                    calledArgumentFacets: string[];
                    scriptedArgumentFacets: string[];
                    invalidScriptedArgumentFacets: string[];
                    uncalledScriptedArgumentFacets: string[];
                };
            };
            const expectedFacets = [
                "set_battery:backend=android-emulator",
                "set_battery:charging=true",
                "set_battery:confirmDestructive=true",
                "set_battery:level=42",
                "set_battery:status=2",
            ];
            expect(summary.toolCoverage.calledArgumentFacets).toEqual(expect.arrayContaining(expectedFacets));
            expect(summary.toolCoverage.scriptedArgumentFacets).toEqual(expect.arrayContaining(expectedFacets));
            expect(summary.toolCoverage.invalidScriptedArgumentFacets).toEqual([]);
            expect(summary.toolCoverage.uncalledScriptedArgumentFacets).toEqual([]);
        } finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it("records advertised enum facet gaps in proof summaries", () => {
        const tempDir = mkdtempSync(join(tmpdir(), "ccc-real-test-enum-facets-"));
        try {
            const facetFile = join(tempDir, "enum-facets.mjs");
            const summaryFile = join(tempDir, "summary.json");
            writeFileSync(facetFile, [
                "export const name='enum-facets';",
                "export async function run(){",
                "  const key = Symbol.for('ccc.deviceLabRealTests.toolCalls');",
                "  globalThis[key] = [{ name: 'click', arguments: { x: 1, y: 1, button: 'left' }, outcome: 'ok', isError: false }];",
                "  return { status: 'PASS' };",
                "}",
                "",
            ].join("\n"));

            const result = spawnSync(process.execPath, ["--import", repoLoader, join(repoRoot, "scripts", "real-tests", "run.ts"), "--json-summary-file", summaryFile, facetFile], {
                cwd: repoRoot,
                encoding: "utf-8",
            });
            expect(result.status).toBe(0);
            const summary = JSON.parse(readFileSync(summaryFile, "utf-8")) as {
                toolCoverage: {
                    advertisedArgumentEnumFacets: string[];
                    calledAdvertisedArgumentEnumFacets: string[];
                    uncalledAdvertisedArgumentEnumFacets: string[];
                    uncalledProviderArgumentEnumFacets: string[];
                    uncalledNonProviderArgumentEnumFacets: string[];
                };
            };
            expect(summary.toolCoverage.advertisedArgumentEnumFacets).toEqual(expect.arrayContaining([
                "click:button=left",
                "click:button=right",
                "set_orientation:orientation=reverse-landscape",
            ]));
            expect(summary.toolCoverage.calledAdvertisedArgumentEnumFacets).toContain("click:button=left");
            expect(summary.toolCoverage.uncalledAdvertisedArgumentEnumFacets).toContain("click:button=right");
            expect(summary.toolCoverage.uncalledAdvertisedArgumentEnumFacets).not.toContain("click:button=left");
            expect(summary.toolCoverage.uncalledProviderArgumentEnumFacets).toEqual(expect.arrayContaining([
                "devices:backend=android-emulator",
                "create_linux_vm:provider=auto",
            ]));
            expect(summary.toolCoverage.uncalledNonProviderArgumentEnumFacets).toContain("click:button=right");
            expect(summary.toolCoverage.uncalledNonProviderArgumentEnumFacets).not.toContain("status:backend=android-emulator");
        } finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it("records declared scripted MCP argument facets for dynamic call sites", () => {
        const tempDir = mkdtempSync(join(tmpdir(), "ccc-real-test-declared-facets-"));
        try {
            const facetFile = join(tempDir, "declared-facets.mjs");
            const summaryFile = join(tempDir, "summary.json");
            writeFileSync(facetFile, [
                "export const name='declared-facets';",
                "export async function run(){",
                "  const key = Symbol.for('ccc.deviceLabRealTests.toolCalls');",
                "  globalThis[key] = [{ name: 'set_network', arguments: { backend: 'android-emulator', deviceId: 'facet-device', airplaneMode: false, confirmDestructive: true }, outcome: 'ok', isError: false }];",
                "  return { status: 'PASS', scriptedArgumentFacets: ['set_network:airplaneMode=false', 'set_network:confirmDestructive=true'] };",
                "}",
                "",
            ].join("\n"));

            const result = spawnSync(process.execPath, ["--import", repoLoader, join(repoRoot, "scripts", "real-tests", "run.ts"), "--json-summary-file", summaryFile, facetFile], {
                cwd: repoRoot,
                encoding: "utf-8",
            });
            expect(result.status).toBe(0);
            const summary = JSON.parse(readFileSync(summaryFile, "utf-8")) as {
                toolCoverage: {
                    scriptedArgumentFacets: string[];
                    invalidScriptedArgumentFacets: string[];
                    uncalledScriptedArgumentFacets: string[];
                    scripted: Array<{ source: string; facets?: string[] }>;
                };
            };
            expect(summary.toolCoverage.scriptedArgumentFacets).toEqual(expect.arrayContaining([
                "set_network:airplaneMode=false",
                "set_network:confirmDestructive=true",
            ]));
            expect(summary.toolCoverage.invalidScriptedArgumentFacets).toEqual([]);
            expect(summary.toolCoverage.uncalledScriptedArgumentFacets).toEqual([]);
            expect(summary.toolCoverage.scripted).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    source: "declared-scripted-argument-facet",
                    facets: ["set_network:airplaneMode=false"],
                }),
            ]));
        } finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it("can fail strict coverage on invalid scripted MCP argument facets", () => {
        const tempDir = mkdtempSync(join(tmpdir(), "ccc-real-test-invalid-scripted-facets-"));
        try {
            const facetFile = join(tempDir, "invalid-scripted-facets.mjs");
            const summaryFile = join(tempDir, "summary.json");
            writeFileSync(facetFile, [
                "export const name='invalid-scripted-facets';",
                "export async function run(){",
                "  return { status: 'PASS', scriptedArgumentFacets: ['click:bogus=left', 'missing_tool:button=left', 'not-a-facet'] };",
                "}",
                "",
            ].join("\n"));

            const result = spawnSync(process.execPath, ["--import", repoLoader, join(repoRoot, "scripts", "real-tests", "run.ts"), "--fail-on-coverage-gap", "--json-summary-file", summaryFile, facetFile], {
                cwd: repoRoot,
                encoding: "utf-8",
            });
            expect(result.status).toBe(1);
            expect(result.stdout).toContain(`strictCoverageFailures=${TOOLS.length + 8}`);
            const summary = JSON.parse(readFileSync(summaryFile, "utf-8")) as {
                toolCoverage: {
                    invalidScriptedArgumentFacets: string[];
                };
            };
            expect(summary.toolCoverage.invalidScriptedArgumentFacets).toEqual([
                "click:bogus=left",
                "missing_tool:button=left",
                "not-a-facet",
            ]);
        } finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it("can fail the self-contained node runner on incomplete MCP call outcomes", () => {
        const tempDir = mkdtempSync(join(tmpdir(), "ccc-real-test-outcome-"));
        try {
            const outcomeFile = join(tempDir, "outcome-gap.mjs");
            writeFileSync(outcomeFile, [
                "export const name='outcome-gap';",
                "export async function run(){",
                "  const key = Symbol.for('ccc.deviceLabRealTests.toolCalls');",
                "  globalThis[key] = [{ name: 'status', arguments: { deviceId: 'x11-current-display' }, outcome: 'thrown', error: 'boom' }];",
                "  return { status: 'PASS', scriptedTools: ['status'] };",
                "}",
                "",
            ].join("\n"));

            const result = spawnSync(process.execPath, ["--import", repoLoader, join(repoRoot, "scripts", "real-tests", "run.ts"), "--fail-on-coverage-gap", outcomeFile], {
                cwd: repoRoot,
                encoding: "utf-8",
            });
            expect(result.status).toBe(1);
            expect(result.stdout).toContain("strictOutcomeFailures=1");
        } finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it("can fail the self-contained node runner on unexpected MCP error results", () => {
        const tempDir = mkdtempSync(join(tmpdir(), "ccc-real-test-unexpected-error-"));
        try {
            const outcomeFile = join(tempDir, "unexpected-error.mjs");
            writeFileSync(outcomeFile, [
                "export const name='unexpected-error';",
                "export async function run(){",
                "  const key = Symbol.for('ccc.deviceLabRealTests.toolCalls');",
                "  globalThis[key] = [{ name: 'status', arguments: { deviceId: 'x11-current-display' }, outcome: 'error-result', isError: true }];",
                "  return { status: 'PASS', scriptedTools: ['status'] };",
                "}",
                "",
            ].join("\n"));

            const result = spawnSync(process.execPath, ["--import", repoLoader, join(repoRoot, "scripts", "real-tests", "run.ts"), "--fail-on-coverage-gap", outcomeFile], {
                cwd: repoRoot,
                encoding: "utf-8",
            });
            expect(result.status).toBe(1);
            expect(result.stdout).toContain("strictOutcomeFailures=1");
        } finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it("can fail the self-contained node runner on malformed successful MCP payloads", () => {
        const tempDir = mkdtempSync(join(tmpdir(), "ccc-real-test-ok-payload-"));
        try {
            const outcomeFile = join(tempDir, "ok-payload-gap.mjs");
            writeFileSync(outcomeFile, [
                "export const name='ok-payload-gap';",
                "export async function run(){",
                "  const key = Symbol.for('ccc.deviceLabRealTests.toolCalls');",
                "  globalThis[key] = [{ name: 'status', arguments: { deviceId: 'x11-current-display' }, outcome: 'ok', isError: false, okPayloadText: true, okPayloadJson: false, okPayloadImage: false }];",
                "  return { status: 'PASS', scriptedTools: ['status'] };",
                "}",
                "",
            ].join("\n"));

            const result = spawnSync(process.execPath, ["--import", repoLoader, join(repoRoot, "scripts", "real-tests", "run.ts"), "--fail-on-coverage-gap", outcomeFile], {
                cwd: repoRoot,
                encoding: "utf-8",
            });
            expect(result.status).toBe(1);
            expect(result.stdout).toContain("strictOutcomeFailures=1");
            const summaryLine = result.stdout.split(/\r?\n/).find((line) => line.startsWith("JSON_SUMMARY "));
            expect(summaryLine).toBeFalsy();
        } finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it("can emit a machine-readable real-test summary", () => {
        const tempDir = mkdtempSync(join(tmpdir(), "ccc-real-test-runner-"));
        try {
            const passFile = join(tempDir, "pass.mjs");
            const stepSkipFile = join(tempDir, "step-skip.mjs");
            const summaryFile = join(tempDir, "artifacts", "summary.json");
            const advertisedToolSurface = canonicalDeviceLabToolSurface();
            writeFileSync(passFile, [
                "export const name='pass';",
                "export async function run(){",
                "  const key = Symbol.for('ccc.deviceLabRealTests.toolCalls');",
                "  const sessions = Symbol.for('ccc.deviceLabRealTests.toolSessions');",
                "  globalThis[key] = globalThis[key] || [];",
                "  globalThis[sessions] = globalThis[sessions] || [];",
                `  globalThis[sessions].push({ id: 'fixture-session-1', name: 'fixture-session', serverPath: '/tmp/device-lab-mcp/server.mjs', serverSource: 'source', serverFile: { exists: true, size: 123, sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, advertisedToolSurface: ${JSON.stringify(advertisedToolSurface)}, node: process.execPath, envOverrides: [] });`,
                "  globalThis[key].push({ name: 'status', mcpSessionId: 'fixture-session-1', arguments: { deviceId: 'x11-current-display' }, outcome: 'ok', isError: false, okPayloadText: true, okPayloadJson: true, okPayloadImage: false });",
                "  globalThis[key].push({ name: 'device_broker_rpc', mcpSessionId: 'fixture-session-1', arguments: { method: 'broker.status' }, outcome: 'error-result', isError: true, expectedError: true, errorPayloadJson: true, errorCode: 'broker-unavailable' });",
                "  globalThis[key].push({ name: 'run_flow', mcpSessionId: 'fixture-session-1', arguments: { steps: [{ tool: 'status', arguments: { deviceId: 'x11-current-display' } }] }, outcome: 'ok', isError: false, okPayloadText: true, okPayloadJson: true, okPayloadImage: false, flowSteps: [{ tool: 'status', isError: false, expectedError: false, okPayloadJson: true, okPayloadImage: false }] });",
                "  return { status: 'PASS', detail: 'provider=display', scriptedTools: ['status', 'device_broker_rpc', 'run_flow'] };",
                "}",
                "",
            ].join("\n"));
            writeFileSync(stepSkipFile, "export const name='step-skip'; export async function run(){ return { status: 'SKIP', steps: [{ name: 'inner', status: 'SKIP', reason: 'missing adb', detail: 'backend=android-device' }] }; }\n");

            const result = spawnSync(process.execPath, ["--import", repoLoader, join(repoRoot, "scripts", "real-tests", "run.ts"), "--fail-on-skip", "--json-summary", "--json-summary-file", summaryFile, passFile, stepSkipFile], {
                cwd: repoRoot,
                encoding: "utf-8",
            });
            expect(result.status).toBe(1);
            const summaryLine = result.stdout.split(/\r?\n/).find((line) => line.startsWith("JSON_SUMMARY "));
            expect(summaryLine).toBeTruthy();
            const summary = JSON.parse(summaryLine!.slice("JSON_SUMMARY ".length)) as {
                total: number;
                pass: number;
                skip: number;
                fail: number;
                failOnSkip: boolean;
                strictSkipFailures: number;
                skipCategories: Array<{ category: string; count: number; records: Array<{ test: string; step?: string; reason?: string }> }>;
                toolCoverage: {
                    canonicalToolSurface: { toolCount: number; sha256: string };
                    calledTools: string[];
                    calledPublicTools: string[];
                    calledArgumentFacets: string[];
                    callOutcomes: Record<string, number>;
                    toolEvidenceSummary: Record<string, { evidence: string[] }>;
                    publicToolsWithoutEvidence: string[];
                    publicToolsWithoutDirectOk: string[];
                    publicToolsWithOnlyExpectedErrorEvidence: string[];
                    unexplainedDiagnosticOnlyTools: string[];
                    unjustifiedMissingDirectOkTools: string[];
                    explainedProviderValues: string[];
                    unexplainedProviderArgumentEnumFacets: string[];
                    scriptedTools: string[];
                    scriptedPublicTools: string[];
                    scriptedArgumentFacets: string[];
                    uncalledAdvertisedTools: string[];
                    unscriptedAdvertisedTools: string[];
                    uncalledScriptedTools: string[];
                    uncalledScriptedArgumentFacets: string[];
                    unadvertisedTools: string[];
                    argumentSchemaFailureRecords: Array<{ test: string; tool: string }>;
                    flowStepArgumentSchemaFailures: Array<{ test: string; flowTool: string; tool: string }>;
                    expectedErrorResultRecords: Array<{ test: string; tool: string; expectedError?: boolean; errorPayloadJson?: boolean; errorCode?: string }>;
                    expectedErrorPayloadFailures: Array<{ test: string; tool: string }>;
                    okPublicPayloadFailures: Array<{ test: string; tool: string }>;
                    emptyOkPublicPayloadRecords: Array<{ test: string; tool: string }>;
                    flowStepOutcomeSummary: Record<string, { total: number; ok: number; error: number }>;
                    flowStepToolOutcomeSummary: Record<string, { total: number; ok: number; expectedError: number; unexpectedError: number }>;
                    publicFlowStepTools: string[];
                    publicFlowStepToolsWithoutOkOrExpectedError: string[];
                    expectedFlowStepErrorRecords: Array<{ test: string; flowTool: string; tool: string; isError: boolean }>;
                    unexpectedFlowStepErrorRecords: Array<{ test: string; flowTool: string; tool: string; isError: boolean }>;
                    expectedFlowStepPayloadFailures: Array<{ test: string; flowTool: string; tool: string }>;
                    okPublicFlowStepPayloadFailures: Array<{ test: string; flowTool: string; tool: string }>;
                    emptyOkPublicFlowStepPayloadRecords: Array<{ test: string; flowTool: string; tool: string }>;
                    calls: Array<{ test: string; tool: string; mcpSessionId?: string }>;
                    scripted: Array<{ test?: string; tool: string; source: string }>;
                };
                mcpSessions: Array<{ test: string; id?: string; name: string; serverPath: string; serverSource: string }>;
                records: Array<{ test: string; step?: string; status: string; reason?: string; detail?: string }>;
            };
            expect(summary).toEqual(expect.objectContaining({
                total: 2,
                pass: 1,
                skip: 1,
                fail: 0,
                failOnSkip: true,
                strictSkipFailures: 1,
            }));
            expect(summary.records).toEqual([
                expect.objectContaining({ test: "pass", status: "PASS", detail: "provider=display", tools: ["device_broker_rpc", "run_flow", "status"] }),
                expect.objectContaining({ test: "step-skip", step: "inner", status: "SKIP", reason: "missing adb", detail: "backend=android-device" }),
            ]);
            expect(summary.skipCategories).toEqual([
                {
                    category: "provider-prerequisite",
                    count: 1,
                    records: [{ test: "step-skip", step: "inner", reason: "missing adb" }],
                },
            ]);
            expect(summary.toolCoverage.calledTools).toEqual(["device_broker_rpc", "run_flow", "status"]);
            expect(summary.toolCoverage.canonicalToolSurface).toEqual(canonicalDeviceLabToolSurface());
            expect(summary.toolCoverage.calledPublicTools).toEqual(["run_flow", "status"]);
            expect(summary.toolCoverage.calledArgumentFacets).toEqual(["device_broker_rpc:method=broker.status"]);
            expect(summary.toolCoverage.callOutcomes).toEqual({ "error-result": 1, ok: 2 });
            expect(summary.toolCoverage.toolOutcomeSummary).toEqual(expect.objectContaining({
                status: expect.objectContaining({ ok: 1, expectedError: 0 }),
                device_broker_rpc: expect.objectContaining({ ok: 0, expectedError: 1 }),
            }));
            expect(summary.toolCoverage.toolEvidenceSummary.status.evidence).toEqual(["direct-ok", "flow-ok"]);
            expect(summary.toolCoverage.publicToolsWithoutEvidence).toEqual([]);
            expect(summary.toolCoverage.publicToolsWithoutDirectOk).toEqual([]);
            expect(summary.toolCoverage.publicToolsWithOnlyExpectedErrorEvidence).toEqual([]);
            expect(summary.toolCoverage.unexplainedDiagnosticOnlyTools).toEqual([]);
            expect(summary.toolCoverage.unjustifiedMissingDirectOkTools).toEqual([]);
            expect(summary.toolCoverage.explainedProviderValues).toEqual([]);
            expect(summary.toolCoverage.unexplainedProviderArgumentEnumFacets).toEqual(expect.arrayContaining([
                "create_linux_vm:provider=container-qemu",
                "create_macos_vm:provider=tart",
            ]));
            expect(summary.toolCoverage.publicToolsWithoutOkOrExpectedError).toEqual([]);
            expect(summary.toolCoverage.scriptedTools).toEqual(["device_broker_rpc", "run_flow", "status"]);
            expect(summary.toolCoverage.scriptedPublicTools).toEqual(["run_flow", "status"]);
            expect(summary.toolCoverage.scriptedArgumentFacets).toEqual([]);
            expect(summary.toolCoverage.uncalledScriptedTools).toEqual([]);
            expect(summary.toolCoverage.uncalledScriptedArgumentFacets).toEqual([]);
            expect(summary.toolCoverage.unadvertisedTools).toEqual(["device_broker_rpc"]);
            expect(summary.toolCoverage.argumentSchemaFailureRecords).toEqual([expect.objectContaining({ tool: "device_broker_rpc", schemaErrors: ["device_broker_rpc:unadvertised"] })]);
            expect(summary.toolCoverage.flowStepArgumentSchemaFailures).toEqual([]);
            expect(summary.toolCoverage.expectedErrorResultRecords).toEqual([
                expect.objectContaining({ test: "pass", tool: "device_broker_rpc", expectedError: true, errorPayloadJson: true, errorCode: "broker-unavailable" }),
            ]);
            expect(summary.toolCoverage.expectedErrorPayloadFailures).toEqual([]);
            expect(summary.toolCoverage.okPublicPayloadFailures).toEqual([]);
            expect(summary.toolCoverage.emptyOkPublicPayloadRecords).toEqual([]);
            expect(summary.toolCoverage.flowStepOutcomeSummary).toEqual({
                status: { total: 1, ok: 1, error: 0 },
            });
            expect(summary.toolCoverage.flowStepToolOutcomeSummary).toEqual({
                status: { total: 1, ok: 1, expectedError: 0, unexpectedError: 0 },
            });
            expect(summary.toolCoverage.publicFlowStepTools).toEqual(["status"]);
            expect(summary.toolCoverage.publicFlowStepToolsWithoutOkOrExpectedError).toEqual([]);
            expect(summary.toolCoverage.expectedFlowStepErrorRecords).toEqual([]);
            expect(summary.toolCoverage.unexpectedFlowStepErrorRecords).toEqual([]);
            expect(summary.toolCoverage.expectedFlowStepPayloadFailures).toEqual([]);
            expect(summary.toolCoverage.okPublicFlowStepPayloadFailures).toEqual([]);
            expect(summary.toolCoverage.emptyOkPublicFlowStepPayloadRecords).toEqual([]);
            expect(summary.toolCoverage.calls).toEqual([
                expect.objectContaining({ test: "pass", tool: "status", mcpSessionId: "fixture-session-1", schemaValid: true }),
                expect.objectContaining({ test: "pass", tool: "device_broker_rpc", mcpSessionId: "fixture-session-1", schemaValid: false }),
                expect.objectContaining({ test: "pass", tool: "run_flow", mcpSessionId: "fixture-session-1", schemaValid: true }),
            ]);
            expect(summary.toolCoverage.scripted).toEqual([
                expect.objectContaining({ test: "pass", tool: "status", source: "declared-scripted-result" }),
                expect.objectContaining({ test: "pass", tool: "device_broker_rpc", source: "declared-scripted-result" }),
                expect.objectContaining({ test: "pass", tool: "run_flow", source: "declared-scripted-result" }),
            ]);
            expect(summary.mcpSessions).toEqual([
                expect.objectContaining({ test: "pass", id: "fixture-session-1", name: "fixture-session", serverPath: "/tmp/device-lab-mcp/server.mjs", serverSource: "source" }),
            ]);
            expect(JSON.parse(readFileSync(summaryFile, "utf-8"))).toEqual(summary);
        } finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it("classifies Hyper-V management permission skips as an allowed host prerequisite", () => {
        const tempDir = mkdtempSync(join(tmpdir(), "ccc-real-test-hyper-v-permission-"));
        try {
            const skipFile = join(tempDir, "hyper-v-permission-skip.mjs");
            const summaryFile = join(tempDir, "summary.json");
            writeFileSync(skipFile, [
                "export const name='level 2 Hyper-V VM E2E';",
                "export async function run(){",
                "  return { status: 'SKIP', steps: [",
                "    { name: 'Hyper-V Windows VM packaged MCP', status: 'SKIP', reason: 'Hyper-V unavailable: hyper-v-management-permission' },",
                "    { name: 'Hyper-V Linux VM packaged MCP', status: 'SKIP', reason: 'Hyper-V unavailable: hyper-v-management-permission' },",
                "  ] };",
                "}",
                "",
            ].join("\n"));

            const collected = spawnSync(process.execPath, [
                "--import", repoLoader,
                join(repoRoot, "scripts", "real-tests", "run.ts"),
                "--json-summary-file",
                summaryFile,
                skipFile,
            ], {
                cwd: repoRoot,
                encoding: "utf-8",
            });
            expect(collected.status).toBe(0);
            const summary = JSON.parse(readFileSync(summaryFile, "utf-8"));
            expect(summary.skipCategories).toEqual([
                {
                    category: "host-permission",
                    count: 2,
                    records: [
                        {
                            test: "level 2 Hyper-V VM E2E",
                            step: "Hyper-V Windows VM packaged MCP",
                            reason: "Hyper-V unavailable: hyper-v-management-permission",
                        },
                        {
                            test: "level 2 Hyper-V VM E2E",
                            step: "Hyper-V Linux VM packaged MCP",
                            reason: "Hyper-V unavailable: hyper-v-management-permission",
                        },
                    ],
                },
            ]);
            expect(summary.toolCoverage.explainedProviderValues).toContain("backend=windows-vm");
            expect(summary.toolCoverage.explainedProviderValues).toContain("backend=linux-vm");

        } finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it("classifies Hyper-V readiness skips and keeps base-image conflicts in other", () => {
        // The macOS VM real-provider smoke reports a missing SSH bridge with the same reason shape;
        // it is a genuine macos-vm prerequisite, so it also explains that backend's coverage gap.
        const macosBridgeSkip = "SKIP - missing ssh, scp";
        const expectedCategories: Record<string, string> = {
            "missing hyper-v-qemu-img-untrusted": "provider-prerequisite",
            "missing hyper-v-qemu-img-unavailable": "provider-prerequisite",
            "SKIP - missing hyper-v-qemu-img-untrusted": "provider-prerequisite",
            // The shapes the smoke and the Linux E2E gate emit, with the probe's closed signature status.
            "missing hyper-v-qemu-img-untrusted (qemu-img signature NotTrusted)": "provider-prerequisite",
            "missing hyper-v-qemu-img-untrusted (qemu-img signature check-failed)": "provider-prerequisite",
            "SKIP - missing hyper-v-qemu-img-untrusted (qemu-img signature check-failed)": "provider-prerequisite",
            "missing powershell.exe, ssh, scp": "provider-prerequisite",
            [macosBridgeSkip]: "provider-prerequisite",
            "missing ssh, scp": "provider-prerequisite",
            "missing scp": "provider-prerequisite",
            "missing powershell": "provider-prerequisite",
            "missing PowerShell": "provider-prerequisite",
            "missing hyper-v-powershell-module, hypervisor, vmms-service": "provider-prerequisite",
            "missing vmms-service": "provider-prerequisite",
            "Hyper-V unavailable: hyper-v-powershell-module, hypervisor, vmms-service": "provider-prerequisite",
            "Hyper-V unavailable: vmms-service": "provider-prerequisite",
            "missing hypervisor": "host-virtualization",
            "SKIP - missing hypervisor": "host-virtualization",
            "Hyper-V unavailable: hypervisor": "host-virtualization",
            // A failed probe's raw stderr is not a readiness token list, whatever it mentions.
            "FAIL - The hypervisor is not running": "other",
            "missing hyper-v-management-permission": "host-permission",
            "missing hypervisor, hyper-v-management-permission": "host-permission",
            "missing hyper-v-base-image-profile-conflict": "other",
            "missing hyper-v-base-image-unmanaged-existing": "other",
            "missing hyper-v-base-image-artifact-owner-unknown": "other",
            "missing hyper-v-base-image-profile-conflict, hyper-v-qemu-img-untrusted": "other",
            "Hyper-V unavailable": "other",
        };
        const reasons = Object.keys(expectedCategories);
        const categoryByReason = (groups: Array<{ category: string; records: Array<{ reason?: string }> }>) => Object.fromEntries(
            groups.flatMap((group) => group.records.map((record) => [record.reason, group.category])),
        );
        const tempDir = mkdtempSync(join(tmpdir(), "ccc-real-test-hyper-v-readiness-"));
        try {
            const skipFile = join(tempDir, "hyper-v-readiness-skip.mjs");
            const summaryFile = join(tempDir, "summary.json");
            const recordsFile = join(tempDir, "records.json");
            const steps = reasons.map((reason, index) => ({
                name: reason === macosBridgeSkip ? "macOS VM real integration slot" : `Hyper-V readiness ${index}`,
                status: "SKIP",
                reason,
            }));
            writeFileSync(skipFile, [
                "export const name='level 1 Hyper-V readiness';",
                `export async function run(){ return { status: 'SKIP', steps: ${JSON.stringify(steps)} }; }`,
                "",
            ].join("\n"));

            const collected = spawnSync(process.execPath, [
                "--import", repoLoader,
                join(repoRoot, "scripts", "real-tests", "run.ts"),
                "--json-summary-file",
                summaryFile,
                skipFile,
            ], {
                cwd: repoRoot,
                encoding: "utf-8",
            });
            expect(collected.status).toBe(0);
            const summary = JSON.parse(readFileSync(summaryFile, "utf-8"));
            expect(categoryByReason(summary.skipCategories)).toEqual(expectedCategories);
            expect(summary.toolCoverage.explainedProviderValues).toEqual(["backend=macos-vm"]);

            writeFileSync(recordsFile, JSON.stringify({
                records: reasons.map((reason) => ({ test: "level 1 Hyper-V readiness", status: "SKIP", reason })),
            }));
            const summarized = spawnSync(process.execPath, ["--import", repoLoader, join(repoRoot, "scripts", "real-tests", "summarize-json.ts"), recordsFile], {
                cwd: repoRoot,
                encoding: "utf-8",
            });
            expect(summarized.status).toBe(0);
            expect(categoryByReason(JSON.parse(summarized.stdout).skippedCategories)).toEqual(expectedCategories);
        } finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it("can summarize real-test JSON artifacts by skip and failure reason", () => {
        const tempDir = mkdtempSync(join(tmpdir(), "ccc-real-test-summary-"));
        try {
            const summaryFile = join(tempDir, "summary.json");
            const canonicalToolSurface = canonicalDeviceLabToolSurface();
            const sourceServerFile = { exists: true, size: 123, sha256: "a".repeat(64) };
            const distServerFile = { exists: true, size: 456, sha256: "b".repeat(64) };
            writeFileSync(summaryFile, JSON.stringify({
                total: 4,
                pass: 1,
                skip: 2,
                fail: 1,
                failOnSkip: true,
                strictSkipFailures: 2,
                failOnCoverageGap: true,
                strictCoverageFailures: 1,
                strictOutcomeFailures: 0,
                toolCoverage: {
                    canonicalToolSurface,
                    advertisedTools: ["devices", "status"],
                    calledTools: ["device_broker_rpc", "status"],
                    calledPublicTools: ["status"],
                    calledArgumentFacets: ["device_broker_rpc:method=broker.status"],
                    callOutcomes: { "error-result": 1, ok: 1 },
                    toolOutcomeSummary: {
                        status: { total: 1, ok: 1, expectedError: 0, unexpectedError: 0, incomplete: 0 },
                        device_broker_rpc: { total: 1, ok: 0, expectedError: 1, unexpectedError: 0, incomplete: 0 },
                    },
                    toolEvidenceSummary: {
                        status: { direct: { total: 1, ok: 1, expectedError: 0, unexpectedError: 0, incomplete: 0 }, flow: { total: 1, ok: 1, expectedError: 0, unexpectedError: 0 }, evidence: ["direct-ok", "flow-ok"] },
                        devices: { direct: { total: 0, ok: 0, expectedError: 0, unexpectedError: 0, incomplete: 0 }, flow: { total: 0, ok: 0, expectedError: 0, unexpectedError: 0 }, evidence: [] },
                    },
                    publicToolsWithoutOkOrExpectedError: [],
                    publicToolsWithoutEvidence: [],
                    publicToolsWithoutDirectOk: ["devices"],
                    publicToolsWithOnlyExpectedErrorEvidence: [],
                    unexplainedDiagnosticOnlyTools: [],
                    unjustifiedMissingDirectOkTools: ["devices"],
                    explainedProviderValues: ["backend=android-device", "backend=android-emulator"],
                    unexplainedProviderArgumentEnumFacets: [],
                    scriptedTools: ["devices", "device_broker_rpc", "status"],
                    scriptedPublicTools: ["devices", "status"],
                    scriptedArgumentFacets: ["device_broker_rpc:method=broker.status"],
                    uncalledAdvertisedTools: ["devices"],
                    unscriptedAdvertisedTools: [],
                    uncalledScriptedTools: ["devices"],
                    uncalledScriptedArgumentFacets: [],
                    invalidScriptedArgumentFacets: [],
                    unadvertisedTools: [],
                    incompleteOutcomeRecords: [],
                    argumentSchemaFailureRecords: [],
                    flowStepArgumentSchemaFailures: [],
                    unexpectedErrorResultRecords: [],
                    expectedErrorResultRecords: [
                        { test: "broker", tool: "device_broker_rpc", outcome: "error-result", expectedError: true, errorPayloadJson: true, errorCode: "broker-unavailable" },
                    ],
                    expectedErrorPayloadFailures: [],
                    okPublicPayloadFailures: [],
                    emptyOkPublicPayloadRecords: [],
                    flowStepOutcomeSummary: {
                        status: { total: 1, ok: 1, error: 0 },
                    },
                    flowStepToolOutcomeSummary: {
                        status: { total: 1, ok: 1, expectedError: 0, unexpectedError: 0 },
                    },
                    publicFlowStepTools: ["status"],
                    publicFlowStepToolsWithoutOkOrExpectedError: [],
                    expectedFlowStepErrorRecords: [
                        { test: "broker", flowTool: "run_flow", tool: "click", isError: true, expectedError: true },
                    ],
                    unexpectedFlowStepErrorRecords: [],
                    expectedFlowStepPayloadFailures: [],
                    okPublicFlowStepPayloadFailures: [],
                    emptyOkPublicFlowStepPayloadRecords: [],
                    calls: [
                        { test: "display", tool: "status", mcpSessionId: "source-session-1" },
                        { test: "broker", tool: "device_broker_rpc", mcpSessionId: "source-session-1", outcome: "error-result", expectedError: true, errorPayloadJson: true, errorCode: "broker-unavailable" },
                    ],
                    scripted: [
                        { test: "display", tool: "status", source: "callTool" },
                        { test: "broker", tool: "device_broker_rpc", source: "callTool" },
                        { test: "devices", tool: "devices", source: "callTool" },
                    ],
                },
                mcpSessions: [
                    { test: "display", id: "source-session-1", name: "source-session", serverPath: "/repo/device-lab-mcp/server.mjs", serverSource: "source", serverFile: sourceServerFile, advertisedToolSurface: canonicalToolSurface, node: process.execPath, envOverrides: [] },
                    { test: "package", id: "dist-session-1", name: "dist-session", serverPath: "/repo/dist/device-lab-mcp/server.mjs", serverSource: "dist", serverFile: distServerFile, advertisedToolSurface: canonicalToolSurface, node: process.execPath, envOverrides: [] },
                ],
                records: [
                    { test: "display", step: "screenshot", status: "PASS" },
                    { test: "readiness", step: "Android emulator", status: "SKIP", reason: "missing adb, emulator" },
                    { test: "readiness", step: "Android device", status: "SKIP", reason: "missing adb, emulator" },
                    { test: "broker", step: "rpc", status: "FAIL", reason: "owner rejected" },
                ],
            }));
            const result = spawnSync(process.execPath, ["--import", repoLoader, join(repoRoot, "scripts", "real-tests", "summarize-json.ts"), summaryFile], {
                cwd: repoRoot,
                encoding: "utf-8",
            });
            const cliResult = spawnSync(process.execPath, [runner, "--summarize-json", summaryFile], {
                cwd: repoRoot,
                encoding: "utf-8",
            });
            expect(result.status).toBe(0);
            expect(cliResult.status).toBe(0);
            expect(JSON.parse(cliResult.stdout)).toEqual(JSON.parse(result.stdout));
            const summary = JSON.parse(result.stdout) as {
                total: number;
                pass: number;
                skip: number;
                fail: number;
                failOnCoverageGap: boolean;
                strictSkipFailures: number;
                strictCoverageFailures: number;
                strictOutcomeFailures: number;
                skippedCategories: Array<{ category: string; count: number }>;
                skippedReasons: Array<{ reason: string; count: number; records: Array<{ test: string; step?: string }> }>;
                failedReasons: Array<{ reason: string; count: number }>;
            };
            expect(summary).toEqual(expect.objectContaining({
                total: 4,
                pass: 1,
                skip: 2,
                fail: 1,
                failOnCoverageGap: true,
                strictSkipFailures: 2,
                strictCoverageFailures: 1,
                strictOutcomeFailures: 0,
                    toolCoverage: {
                        canonicalToolSurface,
                        advertised: 2,
                    called: 2,
                    calledPublic: 1,
                    calledArgumentFacets: 1,
                    callOutcomes: { "error-result": 1, ok: 1 },
                    toolOutcomeSummary: {
                        status: { total: 1, ok: 1, expectedError: 0, unexpectedError: 0, incomplete: 0 },
                        device_broker_rpc: { total: 1, ok: 0, expectedError: 1, unexpectedError: 0, incomplete: 0 },
                    },
                    toolEvidenceSummary: {
                        status: { direct: { total: 1, ok: 1, expectedError: 0, unexpectedError: 0, incomplete: 0 }, flow: { total: 1, ok: 1, expectedError: 0, unexpectedError: 0 }, evidence: ["direct-ok", "flow-ok"] },
                        devices: { direct: { total: 0, ok: 0, expectedError: 0, unexpectedError: 0, incomplete: 0 }, flow: { total: 0, ok: 0, expectedError: 0, unexpectedError: 0 }, evidence: [] },
                    },
                    publicToolsWithoutOkOrExpectedError: [],
                    publicToolsWithoutEvidence: [],
                    publicToolsWithoutDirectOk: ["devices"],
                    publicToolsWithOnlyExpectedErrorEvidence: [],
                    unexplainedDiagnosticOnlyTools: [],
                    unjustifiedMissingDirectOkTools: ["devices"],
                    explainedProviderValues: ["backend=android-device", "backend=android-emulator"],
                    unexplainedProviderArgumentEnumFacets: [],
                    scripted: 3,
                    scriptedPublic: 2,
                    scriptedArgumentFacets: 1,
                    invalidScriptedArgumentFacets: [],
                    uncalledAdvertisedTools: ["devices"],
                    unscriptedAdvertisedTools: [],
                    uncalledScriptedTools: ["devices"],
                    uncalledScriptedArgumentFacets: [],
                    unadvertisedTools: [],
                    incompleteOutcomeRecords: [],
                    argumentSchemaFailureRecords: [],
                    flowStepArgumentSchemaFailures: [],
                    unexpectedErrorResultRecords: [],
                    expectedErrorResultRecords: [
                        { test: "broker", tool: "device_broker_rpc", outcome: "error-result", expectedError: true, errorPayloadJson: true, errorCode: "broker-unavailable" },
                    ],
                    expectedErrorPayloadFailures: [],
                    okPublicPayloadFailures: [],
                    emptyOkPublicPayloadRecords: [],
                    flowStepOutcomeSummary: {
                        status: { total: 1, ok: 1, error: 0 },
                    },
                    flowStepToolOutcomeSummary: {
                        status: { total: 1, ok: 1, expectedError: 0, unexpectedError: 0 },
                    },
                    publicFlowStepTools: ["status"],
                    publicFlowStepToolsWithoutOkOrExpectedError: [],
                    expectedFlowStepErrorRecords: [
                        { test: "broker", flowTool: "run_flow", tool: "click", isError: true, expectedError: true },
                    ],
                    unexpectedFlowStepErrorRecords: [],
                    expectedFlowStepPayloadFailures: [],
                    okPublicFlowStepPayloadFailures: [],
                    emptyOkPublicFlowStepPayloadRecords: [],
                    argumentFacetSamples: ["device_broker_rpc:method=broker.status"],
                    scriptedArgumentFacetSamples: ["device_broker_rpc:method=broker.status"],
                },
                mcpSessions: {
                    total: 2,
                    bySource: { dist: 1, source: 1 },
                    serverPaths: ["/repo/device-lab-mcp/server.mjs", "/repo/dist/device-lab-mcp/server.mjs"],
                    serverFiles: [
                        { path: "/repo/device-lab-mcp/server.mjs", source: "source", size: 123, sha256: "a".repeat(64) },
                        { path: "/repo/dist/device-lab-mcp/server.mjs", source: "dist", size: 456, sha256: "b".repeat(64) },
                    ],
                    advertisedToolSurfaces: [
                        { path: "/repo/device-lab-mcp/server.mjs", source: "source", toolCount: canonicalToolSurface.toolCount, sha256: canonicalToolSurface.sha256 },
                        { path: "/repo/dist/device-lab-mcp/server.mjs", source: "dist", toolCount: canonicalToolSurface.toolCount, sha256: canonicalToolSurface.sha256 },
                    ],
                },
                skippedCategories: [
                    expect.objectContaining({
                        category: "provider-prerequisite",
                        count: 2,
                    }),
                ],
            }));
            expect(summary.skippedReasons).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    reason: "missing adb, emulator",
                    count: 2,
                    records: [
                        { test: "readiness", step: "Android emulator" },
                        { test: "readiness", step: "Android device" },
                    ],
                }),
            ]));
            expect(summary.failedReasons).toEqual([
                expect.objectContaining({ reason: "owner rejected", count: 1 }),
            ]);
        } finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it("can assert real-test JSON proof gates for coverage, outcomes, and skip categories", () => {
        const tempDir = mkdtempSync(join(tmpdir(), "ccc-real-test-assert-"));
        try {
            const passingFile = join(tempDir, "passing.json");
            const failingFile = join(tempDir, "failing.json");
            const uncategorizedSkipFile = join(tempDir, "uncategorized-skip.json");
            const strictSkipFile = join(tempDir, "strict-skip.json");
            const unexplainedProviderGapFile = join(tempDir, "unexplained-provider-gap.json");
            const mismatchedProviderGapFile = join(tempDir, "mismatched-provider-gap.json");
            const staleProviderGapAuditFile = join(tempDir, "stale-provider-gap-audit.json");
            const unexplainedDiagnosticOnlyFile = join(tempDir, "unexplained-diagnostic-only.json");
            const nonExemptDiagnosticOnlyFile = join(tempDir, "non-exempt-diagnostic-only.json");
            const missingDirectOkFile = join(tempDir, "missing-direct-ok.json");
            const staleSurfaceFile = join(tempDir, "stale-surface.json");
            const sourceOnlySessionFile = join(tempDir, "source-only-session.json");
            const missingSessionSourceCoverageFile = join(tempDir, "missing-session-source-coverage.json");
            const missingSessionSourceDirectOkFile = join(tempDir, "missing-session-source-direct-ok.json");
            const missingFingerprintFile = join(tempDir, "missing-fingerprint.json");
            const unlinkedCallFile = join(tempDir, "unlinked-call.json");
            const staleSessionSurfaceFile = join(tempDir, "stale-session-surface.json");
            const forbiddenSessionEnvFile = join(tempDir, "forbidden-session-env.json");
            const hyperVPermissionSkipFile = join(tempDir, "hyper-v-permission-skip.json");
            const sourceServerFile = { exists: true, size: 123, sha256: "a".repeat(64) };
            const distServerFile = { exists: true, size: 456, sha256: "b".repeat(64) };
            const advertisedToolSurface = canonicalDeviceLabToolSurface();
            const baseSummary = {
                total: 3,
                pass: 2,
                skip: 1,
                fail: 0,
                strictSkipFailures: 0,
                strictCoverageFailures: 0,
                strictOutcomeFailures: 0,
                skipCategories: [
                    { category: "provider-prerequisite", count: 1, records: [{ test: "macOS VM readiness", reason: "missing tart, vz, utmctl" }] },
                ],
                toolCoverage: {
                    canonicalToolSurface: canonicalDeviceLabToolSurface(),
                    advertisedTools: ["status"],
                    calledPublicTools: ["status"],
                    unscriptedAdvertisedTools: [],
                    uncalledAdvertisedTools: [],
                    publicToolsWithoutOkOrExpectedError: [],
                    toolEvidenceSummary: {
                        status: { direct: { total: 1, ok: 1, expectedError: 0, unexpectedError: 0, incomplete: 0 }, flow: { total: 0, ok: 0, expectedError: 0, unexpectedError: 0 }, evidence: ["direct-ok"] },
                    },
                    publicToolsWithoutEvidence: [],
                    publicToolsWithoutDirectOk: [],
                    publicToolsWithOnlyExpectedErrorEvidence: [],
                    calledAdvertisedArgumentEnumFacets: [],
                    uncalledScriptedTools: [],
                    uncalledScriptedArgumentFacets: [],
                    invalidScriptedArgumentFacets: [],
                    uncalledAdvertisedArgumentEnumFacets: ["status:backend=macos-vm", "create:provider=tart"],
                    unadvertisedTools: [],
                    incompleteOutcomeRecords: [],
                    argumentSchemaFailureRecords: [],
                    flowStepArgumentSchemaFailures: [],
                    unexpectedErrorResultRecords: [],
                    expectedErrorPayloadFailures: [],
                    okPublicPayloadFailures: [],
                    emptyOkPublicPayloadRecords: [],
                    publicFlowStepToolsWithoutOkOrExpectedError: [],
                    unexpectedFlowStepErrorRecords: [],
                    expectedFlowStepPayloadFailures: [],
                    okPublicFlowStepPayloadFailures: [],
                    emptyOkPublicFlowStepPayloadRecords: [],
                    calls: [
                        { test: "display", tool: "status", outcome: "ok", mcpSessionId: "source-session-1" },
                        { test: "package", tool: "status", outcome: "ok", mcpSessionId: "dist-session-1" },
                    ],
                },
                mcpSessions: [
                    { test: "display", id: "source-session-1", name: "source-session", serverPath: "/repo/device-lab-mcp/server.mjs", serverSource: "source", serverFile: sourceServerFile, advertisedToolSurface, node: process.execPath, envOverrides: [] },
                    { test: "package", id: "dist-session-1", name: "dist-session", serverPath: "/repo/dist/device-lab-mcp/server.mjs", serverSource: "dist", serverFile: distServerFile, advertisedToolSurface, node: process.execPath, envOverrides: [] },
                ],
            };
            writeFileSync(passingFile, JSON.stringify(baseSummary));
            writeFileSync(hyperVPermissionSkipFile, JSON.stringify({
                ...baseSummary,
                total: 5,
                skip: 3,
                skipCategories: [
                    ...baseSummary.skipCategories,
                    {
                        category: "host-permission",
                        count: 2,
                        records: [
                            {
                                test: "level 2 Hyper-V Windows VM E2E",
                                reason: "Hyper-V unavailable: hyper-v-management-permission",
                            },
                            {
                                test: "level 2 Hyper-V Linux VM E2E",
                                reason: "Hyper-V unavailable: hyper-v-management-permission",
                            },
                        ],
                    },
                ],
            }));
            writeFileSync(failingFile, JSON.stringify({
                ...baseSummary,
                fail: 1,
                strictCoverageFailures: 1,
                skipCategories: [{ category: "other", count: 1, records: [{ test: "mystery", reason: "ambiguous skip" }] }],
                toolCoverage: {
                    ...baseSummary.toolCoverage,
                    unscriptedAdvertisedTools: ["devices"],
                    uncalledScriptedTools: ["devices"],
                    publicToolsWithoutOkOrExpectedError: ["devices"],
                    publicToolsWithoutEvidence: ["devices"],
                    invalidScriptedArgumentFacets: ["click:bogus=left"],
                    uncalledAdvertisedArgumentEnumFacets: [
                        "status:backend=macos-vm",
                        "scroll:direction=left",
                    ],
                    unexpectedErrorResultRecords: [{ test: "broker", tool: "device_broker_rpc" }],
                    argumentSchemaFailureRecords: [{ test: "display", tool: "click", schemaValid: false, schemaErrors: ["arguments.x:required"] }],
                    flowStepArgumentSchemaFailures: [{ test: "display", flowTool: "run_flow", index: 0, tool: "click", schemaErrors: ["arguments.x:required"], schemaErrorCount: 1 }],
                    expectedErrorPayloadFailures: [{ test: "broker", tool: "device_broker_rpc", expectedError: true }],
                    okPublicPayloadFailures: [{ test: "display", tool: "status", okPayloadText: true, okPayloadJson: false, okPayloadImage: false }],
                    emptyOkPublicPayloadRecords: [{ test: "display", tool: "status", okPayloadJson: true, okPayloadShape: { kind: "object", keys: [] } }],
                    publicFlowStepToolsWithoutOkOrExpectedError: ["status"],
                    unexpectedFlowStepErrorRecords: [{ test: "display", flowTool: "run_flow", tool: "status", isError: true }],
                    expectedFlowStepPayloadFailures: [{ test: "broker", flowTool: "run_flow", tool: "click", isError: true, expectedError: true, errorPayloadJson: false }],
                    okPublicFlowStepPayloadFailures: [{ test: "display", flowTool: "run_flow", tool: "status", isError: false, okPayloadJson: false, okPayloadImage: false }],
                    emptyOkPublicFlowStepPayloadRecords: [{ test: "display", flowTool: "run_flow", tool: "status", isError: false, okPayloadJson: true, okPayloadShape: { kind: "object", keys: [] } }],
                },
            }));
            writeFileSync(uncategorizedSkipFile, JSON.stringify({ ...baseSummary, skipCategories: [] }));
            writeFileSync(strictSkipFile, JSON.stringify({ ...baseSummary, strictSkipFailures: 1 }));
            writeFileSync(unexplainedProviderGapFile, JSON.stringify({ ...baseSummary, skip: 0, skipCategories: [] }));
            writeFileSync(mismatchedProviderGapFile, JSON.stringify({
                ...baseSummary,
                skipCategories: [{ category: "provider-prerequisite", count: 1, records: [{ test: "Android physical readiness", reason: "missing adb" }] }],
            }));
            writeFileSync(staleProviderGapAuditFile, JSON.stringify({
                ...baseSummary,
                toolCoverage: {
                    ...baseSummary.toolCoverage,
                    explainedProviderValues: [],
                    unexplainedProviderArgumentEnumFacets: ["status:backend=macos-vm"],
                    unexplainedDiagnosticOnlyTools: ["status"],
                    unjustifiedMissingDirectOkTools: ["status"],
                },
            }));
            writeFileSync(unexplainedDiagnosticOnlyFile, JSON.stringify({
                ...baseSummary,
                toolCoverage: {
                    ...baseSummary.toolCoverage,
                    advertisedTools: ["status", "devices"],
                    calledPublicTools: ["status", "devices"],
                    publicToolsWithOnlyExpectedErrorEvidence: ["devices"],
                    uncalledAdvertisedArgumentEnumFacets: [],
                    toolEvidenceSummary: {
                        ...baseSummary.toolCoverage.toolEvidenceSummary,
                        devices: { direct: { total: 1, ok: 0, expectedError: 1, unexpectedError: 0, incomplete: 0 }, flow: { total: 0, ok: 0, expectedError: 0, unexpectedError: 0 }, evidence: ["direct-expected-error"] },
                    },
                    calls: [
                        ...baseSummary.toolCoverage.calls,
                        { test: "display", tool: "devices", outcome: "expected-error", mcpSessionId: "source-session-1" },
                        { test: "package", tool: "devices", outcome: "expected-error", mcpSessionId: "dist-session-1" },
                    ],
                },
            }));
            writeFileSync(nonExemptDiagnosticOnlyFile, JSON.stringify({
                ...baseSummary,
                toolCoverage: {
                    ...baseSummary.toolCoverage,
                    advertisedTools: ["status"],
                    calledPublicTools: ["status"],
                    publicToolsWithoutDirectOk: ["status"],
                    publicToolsWithOnlyExpectedErrorEvidence: ["status"],
                    calledAdvertisedArgumentEnumFacets: ["status:backend=macos-vm"],
                    uncalledAdvertisedArgumentEnumFacets: [],
                    toolEvidenceSummary: {
                        status: { direct: { total: 1, ok: 0, expectedError: 1, unexpectedError: 0, incomplete: 0 }, flow: { total: 0, ok: 0, expectedError: 0, unexpectedError: 0 }, evidence: ["direct-expected-error"] },
                    },
                    calls: [
                        { test: "display", tool: "status", outcome: "expected-error", mcpSessionId: "source-session-1" },
                        { test: "package", tool: "status", outcome: "expected-error", mcpSessionId: "dist-session-1" },
                    ],
                },
            }));
            writeFileSync(missingDirectOkFile, JSON.stringify({
                ...baseSummary,
                toolCoverage: {
                    ...baseSummary.toolCoverage,
                    publicToolsWithoutDirectOk: ["status"],
                    toolEvidenceSummary: {
                        ...baseSummary.toolCoverage.toolEvidenceSummary,
                        status: { direct: { total: 0, ok: 0, expectedError: 0, unexpectedError: 0, incomplete: 0 }, flow: { total: 1, ok: 1, expectedError: 0, unexpectedError: 0 }, evidence: ["flow-ok"] },
                    },
                },
            }));
            writeFileSync(staleSurfaceFile, JSON.stringify({
                ...baseSummary,
                toolCoverage: {
                    ...baseSummary.toolCoverage,
                    canonicalToolSurface: { toolCount: 0, sha256: "stale" },
                },
            }));
            writeFileSync(sourceOnlySessionFile, JSON.stringify({
                ...baseSummary,
                toolCoverage: {
                    ...baseSummary.toolCoverage,
                    calls: [
                        { test: "display", tool: "status", outcome: "ok", mcpSessionId: "source-session-1" },
                    ],
                },
                mcpSessions: [
                    { test: "display", id: "source-session-1", name: "source-session", serverPath: "/repo/device-lab-mcp/server.mjs", serverSource: "source", serverFile: sourceServerFile, advertisedToolSurface, node: process.execPath, envOverrides: [] },
                ],
            }));
            writeFileSync(missingSessionSourceCoverageFile, JSON.stringify({
                ...baseSummary,
                toolCoverage: {
                    ...baseSummary.toolCoverage,
                    calls: [
                        { test: "display", tool: "status", outcome: "ok", mcpSessionId: "source-session-1" },
                        { test: "package", tool: "status", outcome: "declared", mcpSessionId: "dist-session-1" },
                    ],
                },
            }));
            writeFileSync(missingSessionSourceDirectOkFile, JSON.stringify({
                ...baseSummary,
                toolCoverage: {
                    ...baseSummary.toolCoverage,
                    calls: [
                        { test: "display", tool: "status", outcome: "ok", mcpSessionId: "source-session-1" },
                        { test: "package", tool: "status", outcome: "error-result", expectedError: true, mcpSessionId: "dist-session-1" },
                    ],
                },
            }));
            writeFileSync(missingFingerprintFile, JSON.stringify({
                ...baseSummary,
                mcpSessions: [
                    { test: "display", id: "source-session-1", name: "source-session", serverPath: "/repo/device-lab-mcp/server.mjs", serverSource: "source", advertisedToolSurface, node: process.execPath, envOverrides: [] },
                    { test: "package", id: "dist-session-1", name: "dist-session", serverPath: "/repo/dist/device-lab-mcp/server.mjs", serverSource: "dist", serverFile: distServerFile, advertisedToolSurface, node: process.execPath, envOverrides: [] },
                ],
            }));
            writeFileSync(unlinkedCallFile, JSON.stringify({
                ...baseSummary,
                toolCoverage: {
                    ...baseSummary.toolCoverage,
                    calls: [
                        ...baseSummary.toolCoverage.calls,
                        { test: "display", tool: "status", outcome: "ok", mcpSessionId: "missing-session" },
                    ],
                },
            }));
            writeFileSync(staleSessionSurfaceFile, JSON.stringify({
                ...baseSummary,
                mcpSessions: [
                    { test: "display", id: "source-session-1", name: "source-session", serverPath: "/repo/device-lab-mcp/server.mjs", serverSource: "source", serverFile: sourceServerFile, advertisedToolSurface: { toolCount: 0, sha256: "stale" }, node: process.execPath, envOverrides: [] },
                    { test: "package", id: "dist-session-1", name: "dist-session", serverPath: "/repo/dist/device-lab-mcp/server.mjs", serverSource: "dist", serverFile: distServerFile, advertisedToolSurface, node: process.execPath, envOverrides: [] },
                ],
            }));
            writeFileSync(forbiddenSessionEnvFile, JSON.stringify({
                ...baseSummary,
                mcpSessions: [
                    { test: "display", id: "source-session-1", name: "source-session", serverPath: "/repo/device-lab-mcp/server.mjs", serverSource: "source", serverFile: sourceServerFile, advertisedToolSurface, node: process.execPath, envOverrides: ["CCC_DEVICE_LAB_OWNER_BASIS"] },
                    { test: "package", id: "dist-session-1", name: "dist-session", serverPath: "/repo/dist/device-lab-mcp/server.mjs", serverSource: "dist", serverFile: distServerFile, advertisedToolSurface, node: process.execPath, envOverrides: ["HOME"] },
                ],
            }));

            const passing = spawnSync(process.execPath, [runner, "--assert-json", passingFile], {
                cwd: repoRoot,
                encoding: "utf-8",
            });
            expect(passing.status).toBe(0);
            expect(JSON.parse(passing.stdout)).toEqual(expect.objectContaining({
                ok: true,
                failures: [],
                calledPublic: 1,
                advertised: 1,
                mcpSessions: expect.objectContaining({
                    total: 2,
                    bySource: { dist: 1, source: 1 },
                }),
                unlinkedMcpCallRecords: [],
                forbiddenMcpSessionEnvOverrides: [],
                publicToolsByMcpSessionSource: { dist: ["status"], source: ["status"] },
                missingPublicToolsByMcpSessionSource: {},
                publicToolsWithoutDirectOkByMcpSessionSource: { dist: [], source: [] },
                unjustifiedMissingDirectOkToolsByMcpSessionSource: {},
                unexplainedDiagnosticOnlyTools: [],
                unjustifiedMissingDirectOkTools: [],
                providerGapAuditMismatches: [],
            }));

            const quietPassing = spawnSync(process.execPath, [runner, "--assert-json", passingFile, "--quiet"], {
                cwd: repoRoot,
                encoding: "utf-8",
            });
            expect(quietPassing.status).toBe(0);
            expect(quietPassing.stdout).toBe("");
            expect(quietPassing.stderr).toBe("");

            const hyperVPermissionSkip = spawnSync(process.execPath, [runner, "--assert-json", hyperVPermissionSkipFile, "--quiet"], {
                cwd: repoRoot,
                encoding: "utf-8",
            });
            expect(hyperVPermissionSkip.status).toBe(0);
            expect(hyperVPermissionSkip.stdout).toBe("");
            expect(hyperVPermissionSkip.stderr).toBe("");

            const noSkipsAllowed = spawnSync(process.execPath, [runner, "--assert-json", passingFile], {
                cwd: repoRoot,
                encoding: "utf-8",
                env: { ...process.env, CCC_REAL_DEVICE_LAB_ALLOWED_SKIP_CATEGORIES: "" },
            });
            expect(noSkipsAllowed.status).toBe(1);
            expect(JSON.parse(noSkipsAllowed.stdout)).toEqual(expect.objectContaining({
                ok: false,
                failures: ["unexpectedSkipCategories=provider-prerequisite"],
            }));

            const strictSkip = spawnSync(process.execPath, [runner, "--assert-json", strictSkipFile], {
                cwd: repoRoot,
                encoding: "utf-8",
            });
            expect(strictSkip.status).toBe(1);
            expect(JSON.parse(strictSkip.stdout)).toEqual(expect.objectContaining({
                ok: false,
                failures: ["strictSkipFailures=1"],
                strictSkipFailures: 1,
            }));

            const failing = spawnSync(process.execPath, [runner, "--assert-json", failingFile], {
                cwd: repoRoot,
                encoding: "utf-8",
            });
            expect(failing.status).toBe(1);
            expect(JSON.parse(failing.stdout)).toEqual(expect.objectContaining({
                ok: false,
                failures: expect.arrayContaining([
                    "fail=1",
                    "strictCoverageFailures=1",
                    "unscriptedAdvertisedTools=1",
                    "uncalledScriptedTools=1",
                    "publicToolsWithoutOkOrExpectedError=1",
                    "publicToolsWithoutEvidence=1",
                    "invalidScriptedArgumentFacets=1",
                    "uncalledNonProviderArgumentEnumFacets=1",
                    "argumentSchemaFailureRecords=1",
                    "flowStepArgumentSchemaFailures=1",
                    "unexpectedErrorResultRecords=1",
                    "expectedErrorPayloadFailures=1",
                    "okPublicPayloadFailures=1",
                    "emptyOkPublicPayloadRecords=1",
                    "publicFlowStepToolsWithoutOkOrExpectedError=1",
                    "unexpectedFlowStepErrorRecords=1",
                    "expectedFlowStepPayloadFailures=1",
                    "okPublicFlowStepPayloadFailures=1",
                    "emptyOkPublicFlowStepPayloadRecords=1",
                    "unexpectedSkipCategories=other",
                ]),
            }));

            const quietFailing = spawnSync(process.execPath, [runner, "--assert-json", failingFile, "--quiet"], {
                cwd: repoRoot,
                encoding: "utf-8",
            });
            expect(quietFailing.status).toBe(1);
            expect(quietFailing.stdout).toBe("");
            expect(quietFailing.stderr).toContain("VALIDATION FAILED fail=1");

            const uncategorizedSkip = spawnSync(process.execPath, [runner, "--assert-json", uncategorizedSkipFile], {
                cwd: repoRoot,
                encoding: "utf-8",
            });
            expect(uncategorizedSkip.status).toBe(1);
            expect(JSON.parse(uncategorizedSkip.stdout)).toEqual(expect.objectContaining({
                ok: false,
                failures: expect.arrayContaining([
                    "uncategorizedSkips=1",
                    "unexplainedProviderArgumentEnumFacets=2",
                ]),
            }));

            const unexplainedProviderGap = spawnSync(process.execPath, [runner, "--assert-json", unexplainedProviderGapFile], {
                cwd: repoRoot,
                encoding: "utf-8",
            });
            expect(unexplainedProviderGap.status).toBe(1);
            expect(JSON.parse(unexplainedProviderGap.stdout)).toEqual(expect.objectContaining({
                ok: false,
                failures: ["unexplainedProviderArgumentEnumFacets=2"],
            }));

            const mismatchedProviderGap = spawnSync(process.execPath, [runner, "--assert-json", mismatchedProviderGapFile], {
                cwd: repoRoot,
                encoding: "utf-8",
            });
            expect(mismatchedProviderGap.status).toBe(1);
            expect(JSON.parse(mismatchedProviderGap.stdout)).toEqual(expect.objectContaining({
                ok: false,
                failures: ["unexplainedProviderArgumentEnumFacets=2"],
                explainedProviderValues: ["backend=android-device"],
            }));

            const staleProviderGapAudit = spawnSync(process.execPath, [runner, "--assert-json", staleProviderGapAuditFile], {
                cwd: repoRoot,
                encoding: "utf-8",
            });
            expect(staleProviderGapAudit.status).toBe(1);
            expect(JSON.parse(staleProviderGapAudit.stdout)).toEqual(expect.objectContaining({
                ok: false,
                failures: ["providerGapAuditMismatch=4"],
                providerGapAuditMismatches: expect.arrayContaining([
                    expect.objectContaining({ field: "explainedProviderValues" }),
                    expect.objectContaining({ field: "unexplainedProviderArgumentEnumFacets" }),
                    expect.objectContaining({ field: "unexplainedDiagnosticOnlyTools" }),
                    expect.objectContaining({ field: "unjustifiedMissingDirectOkTools" }),
                ]),
            }));

            const unexplainedDiagnosticOnly = spawnSync(process.execPath, [runner, "--assert-json", unexplainedDiagnosticOnlyFile], {
                cwd: repoRoot,
                encoding: "utf-8",
            });
            expect(unexplainedDiagnosticOnly.status).toBe(1);
            expect(JSON.parse(unexplainedDiagnosticOnly.stdout)).toEqual(expect.objectContaining({
                ok: false,
                failures: ["unexplainedDiagnosticOnlyTools=1"],
                unexplainedDiagnosticOnlyTools: ["devices"],
            }));

            const nonExemptDiagnosticOnly = spawnSync(process.execPath, [runner, "--assert-json", nonExemptDiagnosticOnlyFile], {
                cwd: repoRoot,
                encoding: "utf-8",
            });
            expect(nonExemptDiagnosticOnly.status).toBe(1);
            expect(JSON.parse(nonExemptDiagnosticOnly.stdout)).toEqual(expect.objectContaining({
                ok: false,
                failures: ["unjustifiedMissingDirectOkTools=1"],
                unexplainedDiagnosticOnlyTools: [],
                unjustifiedMissingDirectOkTools: ["status"],
            }));

            const missingDirectOk = spawnSync(process.execPath, [runner, "--assert-json", missingDirectOkFile], {
                cwd: repoRoot,
                encoding: "utf-8",
            });
            expect(missingDirectOk.status).toBe(1);
            expect(JSON.parse(missingDirectOk.stdout)).toEqual(expect.objectContaining({
                ok: false,
                failures: ["unjustifiedMissingDirectOkTools=1"],
                unjustifiedMissingDirectOkTools: ["status"],
            }));

            const staleSurface = spawnSync(process.execPath, [runner, "--assert-json", staleSurfaceFile], {
                cwd: repoRoot,
                encoding: "utf-8",
            });
            expect(staleSurface.status).toBe(1);
            expect(JSON.parse(staleSurface.stdout)).toEqual(expect.objectContaining({
                ok: false,
                failures: ["canonicalToolSurfaceMismatch(source-changed-since-run; saved results do not validate the current tool schema)"],
            }));

            const sourceOnlySession = spawnSync(process.execPath, [runner, "--assert-json", sourceOnlySessionFile], {
                cwd: repoRoot,
                encoding: "utf-8",
            });
            expect(sourceOnlySession.status).toBe(1);
            expect(JSON.parse(sourceOnlySession.stdout)).toEqual(expect.objectContaining({
                ok: false,
                failures: ["missingMcpSessionSources=dist"],
            }));

            const missingSessionSourceCoverage = spawnSync(process.execPath, [runner, "--assert-json", missingSessionSourceCoverageFile], {
                cwd: repoRoot,
                encoding: "utf-8",
            });
            expect(missingSessionSourceCoverage.status).toBe(1);
            expect(JSON.parse(missingSessionSourceCoverage.stdout)).toEqual(expect.objectContaining({
                ok: false,
                failures: ["missingPublicToolsByMcpSessionSource=1"],
                missingPublicToolsByMcpSessionSource: { dist: ["status"] },
            }));

            const platformResultCoverage = spawnSync(process.execPath, [runner, "--assert-json", missingSessionSourceCoverageFile, "--platform-result"], {
                cwd: repoRoot,
                encoding: "utf-8",
            });
            expect(platformResultCoverage.status).toBe(0);
            expect(JSON.parse(platformResultCoverage.stdout)).toEqual(expect.objectContaining({
                ok: true,
                failures: [],
                missingPublicToolsByMcpSessionSource: { dist: ["status"] },
            }));

            const missingSessionSourceDirectOk = spawnSync(process.execPath, [runner, "--assert-json", missingSessionSourceDirectOkFile], {
                cwd: repoRoot,
                encoding: "utf-8",
            });
            expect(missingSessionSourceDirectOk.status).toBe(1);
            expect(JSON.parse(missingSessionSourceDirectOk.stdout)).toEqual(expect.objectContaining({
                ok: false,
                failures: ["unjustifiedMissingDirectOkToolsByMcpSessionSource=1"],
                publicToolsWithoutDirectOkByMcpSessionSource: { dist: ["status"], source: [] },
                unjustifiedMissingDirectOkToolsByMcpSessionSource: { dist: ["status"] },
            }));

            const missingFingerprint = spawnSync(process.execPath, [runner, "--assert-json", missingFingerprintFile], {
                cwd: repoRoot,
                encoding: "utf-8",
            });
            expect(missingFingerprint.status).toBe(1);
            expect(JSON.parse(missingFingerprint.stdout)).toEqual(expect.objectContaining({
                ok: false,
                failures: ["invalidMcpSessionFingerprints=1"],
            }));

            const unlinkedCall = spawnSync(process.execPath, [runner, "--assert-json", unlinkedCallFile], {
                cwd: repoRoot,
                encoding: "utf-8",
            });
            expect(unlinkedCall.status).toBe(1);
            expect(JSON.parse(unlinkedCall.stdout)).toEqual(expect.objectContaining({
                ok: false,
                failures: ["unlinkedMcpCallRecords=1"],
            }));

            const staleSessionSurface = spawnSync(process.execPath, [runner, "--assert-json", staleSessionSurfaceFile], {
                cwd: repoRoot,
                encoding: "utf-8",
            });
            expect(staleSessionSurface.status).toBe(1);
            expect(JSON.parse(staleSessionSurface.stdout)).toEqual(expect.objectContaining({
                ok: false,
                failures: ["invalidMcpSessionToolSurfaces=1"],
            }));

            const forbiddenSessionEnv = spawnSync(process.execPath, [runner, "--assert-json", forbiddenSessionEnvFile], {
                cwd: repoRoot,
                encoding: "utf-8",
            });
            expect(forbiddenSessionEnv.status).toBe(1);
            expect(JSON.parse(forbiddenSessionEnv.stdout)).toEqual(expect.objectContaining({
                ok: false,
                failures: ["forbiddenMcpSessionEnvOverrides=1"],
                forbiddenMcpSessionEnvOverrides: [{ session: "source-session-1", key: "CCC_DEVICE_LAB_OWNER_BASIS" }],
            }));
        } finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
});


describe("canonical real-runner argument interpretation", () => {
    it("validates omitted backend defaults and flat inputs while rejecting explicit selectors and wrappers", () => {
        const dir = mkdtempSync(join(tmpdir(), "ccc-input-clarity-runner-"));
        try {
            const fixture = join(dir, "calls.mjs");
            const summaryPath = join(dir, "summary.json");
            const targets: Array<[string, string, Record<string, unknown>]> = [
                ["list_images", "linux-vm", {}],
                ["import_image", "linux-vm", { name: "base", sourcePath: "incoming/base.qcow2" }],
                ["create_macos_vm", "macos-vm", { name: "base", image: "registry/base" }],
                ["create_macos_vm", "macos-vm", { name: "clone", sourceDeviceId: "owned-target" }],
            ];
            const valid: Array<{ name: string; arguments: Record<string, unknown> }> = targets.map(([name, _backend, args]) => ({ name, arguments: { ...args, detail: true } }));
            valid.push({ name: "create_linux_vm", arguments: {  name: "flat", cpus: 2, detail: true } });
            valid.push(
                { name: "create_android_emulator", arguments: {  name: "new", systemImage: "system-images;android-35;google_apis;x86_64" } },
                { name: "create_android_emulator", arguments: {  name: "reuse", avdName: "owned-existing" } },
                { name: "create_ios_simulator", arguments: {  name: "new", deviceType: "iphone", runtime: "ios" } },
                { name: "create_ios_simulator", arguments: {  name: "reuse", udid: "owned-existing" } },
            );
            const invalid = targets.flatMap(([name, backend, args]) => [backend, "", null, false, {}, "unsupported"].flatMap(selector => [
                { name, arguments: { ...args, backend: selector } },
                { name, arguments: { ...args, options: { backend: selector } } },
                { name, arguments: { ...args, backend: selector, options: { backend } } },
            ]));
            invalid.push(...["workspace_sync", "artifacts_export"].map(name => ({ name, arguments: { deviceId: "owned-target" } })));
            invalid.push(
                { name: "create_android_emulator", arguments: {  name: "wrong-backend-field", avdName: "existing", guestSshHost: "localhost" } },
                { name: "create_ios_simulator", arguments: {  name: "conflicting-reuse", udid: "existing", runtime: "ios" } },
                { name: "create_android_emulator", arguments: {  name: "missing-image" } },
            );
            writeFileSync(fixture, `export const name='input-clarity'; export async function run(){globalThis[Symbol.for('ccc.deviceLabRealTests.toolCalls')]=${JSON.stringify([...valid, ...invalid].map(call => ({ ...call, outcome: "ok", isError: false })))};return {status:'PASS'};}`);
            const result = spawnSync(process.execPath, ["--import", repoLoader, join(repoRoot, "scripts/real-tests/run.ts"), "--json-summary-file", summaryPath, fixture], { cwd: repoRoot, encoding: "utf8", timeout: 30000 });
            expect(result.status, result.stderr).toBe(0);
            const coverage = JSON.parse(readFileSync(summaryPath, "utf8")).toolCoverage;
            expect(coverage.calls.slice(0, valid.length).map((call: any) => call.schemaValid)).toEqual(valid.map(() => true));
            expect(coverage.argumentSchemaFailureRecords).toHaveLength(invalid.length);
            expect(coverage.calls.slice(valid.length).every((call: any) => call.schemaValid === false)).toBe(true);
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });
    it("rejects removed aliases and validates canonical shared flow targets", () => {
        const dir = mkdtempSync(join(tmpdir(), "ccc-canonical-runner-"));
        try {
            const fixture = join(dir, "calls.mjs");
            const summaryPath = join(dir, "summary.json");
            const valid = [
                { name: "run_flow", arguments: { deviceId: "android-test", steps: [{ tool: "click", arguments: { x: 1, y: 2 } }] } },
                { name: "install_app", arguments: { deviceId: "android-test", path: "/app.apk" } },
                { name: "launch_app", arguments: { deviceId: "android-test", appId: "com.example" } },
                { name: "screenshot", arguments: { deviceId: "android-test" } },
                { name: "set_orientation", arguments: { deviceId: "android-test", orientation: "landscape" } },
                { name: "run_flow", arguments: { deviceId: "vm-a", steps: [
                    { tool: "click", arguments: { x: 1, y: 2 } },
                    { tool: "click", arguments: { deviceId: "vm-b", x: 3, y: 4 } },
                ] } },
            ];
            const removed = ["mobile_install_app", "mobile_launch_app", "mobile_screenshot", "mobile_rotate_left", "mobile_rotate_right", "mobile_run_flow", "device_broker_rpc"];
            const invalid = [
                ...removed.map(name => ({ name, arguments: { deviceId: "android-test" } })),
                { name: "run_flow", arguments: { deviceId: "vm-a", steps: [] } },
                { name: "run_flow", arguments: { steps: [
                    { tool: "click", arguments: { x: 1, y: 2 } },
                ] } },
                { name: "run_flow", arguments: { deviceId: "vm-a", steps: [{ tool: "click", arguments: null }] } },
                { name: "run_flow", arguments: { deviceId: "vm-a", steps: [{ tool: "click", name: "click", arguments: { x: 1, y: 2 } }] } },
            ];
            writeFileSync(fixture, `export const name='canonical-arguments'; export async function run(){globalThis[Symbol.for('ccc.deviceLabRealTests.toolCalls')]=${JSON.stringify([...valid, ...invalid].map((call) => ({ ...call, outcome: "ok", isError: false })))}; return {status:'PASS'};}`);
            const result = spawnSync(process.execPath, ["--import", repoLoader, join(repoRoot, "scripts/real-tests/run.ts"), "--json-summary-file", summaryPath, fixture], { cwd: repoRoot, encoding: "utf8", timeout: 30000 });
            expect(result.status, result.stderr).toBe(0);
            const coverage = JSON.parse(readFileSync(summaryPath, "utf8")).toolCoverage;
            expect(coverage.unadvertisedTools).toEqual([...removed].sort());
            expect(coverage.calls.slice(0, valid.length).every((call: any) => call.schemaValid)).toBe(true);
            expect(coverage.argumentSchemaFailureRecords).toHaveLength(removed.length + 3);
            expect(coverage.flowStepArgumentSchemaFailures).toHaveLength(2);
            expect(coverage.flowStepArgumentSchemaFailures[0].schemaErrors).toContain("arguments.deviceId:required");
            expect(coverage.flowStepArgumentSchemaFailures[1].schemaErrors).toContain("arguments:type=object");
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });
});
