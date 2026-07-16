import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parse } from "acorn";
import { describe, expect, it } from "vitest";
import { DESTRUCTIVE_POLICY_SCHEMA_EXAMPLES, evaluateDestructivePolicy } from "../../device-lab-mcp/src/policy/destructive.mjs";
import { androidDeviceE2EPrerequisites } from "../../scripts/real-tests/android-device-e2e.mjs";
import { androidEmulatorAppSelection } from "../../scripts/real-tests/android-emulator-e2e.mjs";
import { startWindowsSandboxE2EDevice } from "../../scripts/real-tests/windows-sandbox-e2e.mjs";
import { repoRoot } from "./helpers/device-lab-mcp-fixture.js";

const runner = join(repoRoot, "scripts", "test-level.js");
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
const HIDDEN_COMPATIBILITY_TOOLS = new Set([
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
const HIDDEN_PROVIDER_REAL_E2E_TRANSPORT_KEYS = new Set(
    [...HIDDEN_LEGACY_TRANSPORT_KEYS].filter((key) => key !== "port" && key !== "timeoutMs"),
);
const OPT_IN_REAL_TEST_UTILITY_FILES = new Set([
    "installed-mcp-smoke.mjs",
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

function advertisedDeviceLabToolSchemas() {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", "import { TOOLS } from './device-lab-mcp/src/tools.mjs'; console.log(JSON.stringify(TOOLS.map((tool) => [tool.name, Object.keys(tool.inputSchema?.properties || {})])));"], {
        cwd: repoRoot,
        encoding: "utf-8",
    });
    expect(result.status).toBe(0);
    return new Map((JSON.parse(result.stdout) as Array<[string, string[]]>).map(([name, properties]) => [name, new Set(properties)]));
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
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", "import { TOOLS } from './device-lab-mcp/src/tools.mjs'; console.log(JSON.stringify(TOOLS.map((tool) => [tool.name, Object.fromEntries(Object.entries(tool.inputSchema?.properties || {}).filter(([, schema]) => Array.isArray(schema?.enum)).map(([key, schema]) => [key, schema.enum]))])));"], {
        cwd: repoRoot,
        encoding: "utf-8",
    });
    expect(result.status).toBe(0);
    return new Map(JSON.parse(result.stdout) as Array<[string, Record<string, string[]>]>);
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

function literalObjectBindings(ast: unknown) {
    const bindings = new Map<string, Record<string, unknown> | null>();
    walkAst(ast, (node) => {
        if (node.type !== "VariableDeclarator") return;
        const id = node.id as Record<string, unknown> | undefined;
        const init = node.init as Record<string, unknown> | undefined;
        if (id?.type !== "Identifier" || init?.type !== "ObjectExpression") return;
        const name = String(id.name);
        bindings.set(name, bindings.has(name) ? null : init);
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
        .filter((file) => file.endsWith(".mjs"))
        .flatMap((file) => {
            const text = readFileSync(join(root, file), "utf-8");
            const ast = parse(text, { ecmaVersion: "latest", sourceType: "module" });
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
        .filter((file) => file.endsWith(".mjs"))
        .flatMap((file) => {
            const text = readFileSync(join(root, file), "utf-8");
            const ast = parse(text, { ecmaVersion: "latest", sourceType: "module" });
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
    "device_delete",
    "device_reset",
    "device_snapshot_restore",
    "device_snapshot_delete",
    "mobile_uninstall_app",
    "mobile_clear_app_data",
    "mobile_set_battery",
    "mobile_set_network",
    "mobile_toggle_airplane_mode",
]);

function realTestDestructiveCallsMissingConfirmation() {
    return realTestCallToolArgumentKeys()
        .filter((call) => ALWAYS_DESTRUCTIVE_REAL_E2E_TOOLS.has(call.tool))
        .filter((call) => !call.keys.includes("confirmDestructive"))
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
        .map(({ name }) => name))]
        .sort();
}

function realTestText() {
    const root = join(repoRoot, "scripts", "real-tests");
    return readdirSync(root)
        .filter((file) => file.endsWith(".mjs"))
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
        ...filesUnder(join(repoRoot, "lab-mcp", "src"), [".mjs"]),
        ...filesUnder(join(repoRoot, "scripts", "real-tests"), [".mjs"]),
        join(repoRoot, "src", "device-lab-owner.ts"),
        join(repoRoot, "src", "device-lab-broker.ts"),
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

function deviceLabServerLiteralSets() {
    const text = readFileSync(join(repoRoot, "device-lab-mcp", "src", "server.mjs"), "utf-8");
    const ast = parse(text, { ecmaVersion: "latest", sourceType: "module" });
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
    return sets;
}

function deviceLabBackendCapabilityTools() {
    const roots = [
        join(repoRoot, "device-lab-mcp", "src", "backends"),
        join(repoRoot, "device-lab-mcp", "src", "display"),
    ];
    const files = roots.flatMap((root) => filesUnder(root, [".mjs"]));
    const capabilities: Array<{ file: string; values: string[] }> = [];
    for (const file of files) {
        const text = readFileSync(file, "utf-8");
        const ast = parse(text, { ecmaVersion: "latest", sourceType: "module" });
        walkAst(ast, (node) => {
            if (node.type === "VariableDeclarator") {
                const id = node.id as Record<string, unknown> | undefined;
                if (id?.type === "Identifier" && /CAPABILITIES$/.test(String(id.name))) {
                    const values = literalStringArrayValues(node.init as Record<string, unknown> | undefined);
                    if (values.length > 0) capabilities.push({ file, values });
                }
            }
            if (node.type !== "Property") return;
            const key = propertyKey(node);
            if (key !== "capabilities") return;
            const values = literalStringArrayValues(node.value as Record<string, unknown> | undefined);
            if (values.length > 0) capabilities.push({ file, values });
        });
    }
    return capabilities;
}

function brokerCommandForwardedInputKeys() {
    const text = readFileSync(join(repoRoot, "device-lab-mcp", "src", "broker.mjs"), "utf-8");
    const match = /export async function brokerCommand[\s\S]*?return brokerRpcRequest\(\{([\s\S]*?)\n\s*\}\);\n\}/.exec(text);
    expect(match).not.toBeNull();
    const body = match?.[1] || "";
    return [...new Set([...body.matchAll(/\b[a-zA-Z_][a-zA-Z0-9_]*:\s*options\.([a-zA-Z_][a-zA-Z0-9_]*)/g)]
        .map((item) => item[1])
        .filter((key) => key !== "timeoutMs"))]
        .sort();
}

function brokerDeviceToolForwardedInputKeys() {
    const text = readFileSync(join(repoRoot, "device-lab-mcp", "src", "broker.mjs"), "utf-8");
    const match = /export const BROKER_DEVICE_TOOL_PARAM_KEYS = \[([\s\S]*?)\];/.exec(text);
    expect(match).not.toBeNull();
    const arrayBody = match?.[1] || "";
    return [...new Set([...arrayBody.matchAll(/["']([a-zA-Z_][a-zA-Z0-9_]*)["']/g)]
        .map((item) => item[1]))]
        .sort();
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
    const text = readFileSync(join(repoRoot, "device-lab-mcp", "src", "broker.mjs"), "utf-8");
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

function hostBrokerAppiumAllowedRequests() {
    const text = readFileSync(join(repoRoot, "src", "device-lab-broker.ts"), "utf-8");
    const match = /const DEVICE_BROKER_APPIUM_REQUEST_ALLOWLIST = new Map<string, ReadonlySet<DeviceBrokerAppiumRequestMethod>>\(\[([\s\S]*?)\n\]\);/.exec(text);
    expect(match).not.toBeNull();
    const body = match?.[1] || "";
    return [...body.matchAll(/\["([^"]+)", new Set\(\[([^\]]+)\]\)\]/g)]
        .flatMap(([, path, methods]) => [...methods.matchAll(/"([^"]+)"/g)].map((method) => `${method[1]} ${path}`))
        .sort();
}

function mcpBrokerAppiumRequests() {
    const text = readFileSync(join(repoRoot, "device-lab-mcp", "src", "server.mjs"), "utf-8");
    return [...new Set([...text.matchAll(/method:\s*"([A-Z]+)",\s*path:\s*"([^"]+)"/g)]
        .map(([, method, path]) => `${method} ${path}`))]
        .sort();
}

function brokerWrapperActionKeys(functionName: string) {
    const text = readFileSync(join(repoRoot, "device-lab-mcp", "src", "broker.mjs"), "utf-8");
    const match = new RegExp(`export async function ${functionName}[\\s\\S]*?const methodByAction = \\{([\\s\\S]*?)\\n\\s*\\};`).exec(text);
    expect(match).not.toBeNull();
    const body = match?.[1] || "";
    return [...body.matchAll(/["']?([a-z][a-z0-9-]*)["']?\s*:/g)]
        .map((item) => item[1])
        .sort();
}

function brokerWrapperForwardedInputKeys(functionName: string) {
    const text = readFileSync(join(repoRoot, "device-lab-mcp", "src", "broker.mjs"), "utf-8");
    const match = new RegExp(`export async function ${functionName}[\\s\\S]*?params:\\s*\\{([\\s\\S]*?)\\n\\s*\\},\\n\\s*\\}\\);\\n\\}`).exec(text);
    expect(match).not.toBeNull();
    const body = match?.[1] || "";
    const forwarded = new Set([...body.matchAll(/\b[a-zA-Z_][a-zA-Z0-9_]*:\s*options\.([a-zA-Z_][a-zA-Z0-9_]*)/g)]
        .map((item) => item[1]));
    if (body.includes("options.devicePort")) forwarded.add("devicePort");
    return [...forwarded].sort();
}

function brokerAppleTrustActionKeys() {
    const text = readFileSync(join(repoRoot, "src", "device-lab-broker.ts"), "utf-8");
    const match = /const DEVICE_BROKER_APPLE_TRUST_ACTIONS = new Set\(\[([^\]]*)\]\);/.exec(text);
    expect(match).not.toBeNull();
    return [...(match?.[1] || "").matchAll(/["']([a-z][a-z0-9-]*)["']/g)]
        .map((item) => item[1])
        .sort();
}

function publicBrokerRpcMethodKeys() {
    const text = readFileSync(join(repoRoot, "device-lab-mcp", "src", "broker.mjs"), "utf-8");
    const match = /const PUBLIC_BROKER_RPC_METHODS = new Set\(\[([^\]]*)\]\);/.exec(text);
    expect(match).not.toBeNull();
    return [...(match?.[1] || "").matchAll(/["']([^"']+)["']/g)]
        .map((item) => item[1])
        .sort();
}

function brokerMobileRequestToolKeys() {
    const text = readFileSync(join(repoRoot, "device-lab-mcp", "src", "server.mjs"), "utf-8");
    const match = /function brokerMobileRequest\(name, args, backend\) \{([\s\S]*?)\n\}\n\nfunction brokerMobilePayload/.exec(text);
    expect(match).not.toBeNull();
    return [...new Set([...(match?.[1] || "").matchAll(/\bname === "([^"]+)"/g)].map((item) => item[1]))].sort();
}

function deviceLabToolSchemaPropertyMap() {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", "import { TOOLS } from './device-lab-mcp/src/tools.mjs'; console.log(JSON.stringify(TOOLS.map((tool) => [tool.name, Object.keys(tool.inputSchema?.properties || {})])));"], {
        cwd: repoRoot,
        encoding: "utf-8",
    });
    expect(result.status).toBe(0);
    return new Map(JSON.parse(result.stdout) as Array<[string, string[]]>);
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
        "import { androidBackend } from './device-lab-mcp/src/backends/android.mjs';",
        "import { androidRealBackend } from './device-lab-mcp/src/backends/android-device.mjs';",
        "import { iosBackend } from './device-lab-mcp/src/backends/ios-simulator.mjs';",
        "import { iosRealBackend } from './device-lab-mcp/src/backends/ios-device.mjs';",
        "import { windowsBackend } from './device-lab-mcp/src/backends/windows-sandbox.mjs';",
        "import { macosBackend } from './device-lab-mcp/src/backends/macos-vm.mjs';",
        "const backends = [androidBackend(), androidRealBackend(), iosBackend(), iosRealBackend(), windowsBackend(), macosBackend()];",
        "console.log(JSON.stringify(backends.map(({ name, capabilities }) => [name, [...capabilities].sort()])));",
    ].join("")], {
        cwd: repoRoot,
        encoding: "utf-8",
    });
    expect(result.status).toBe(0);
    return new Map(JSON.parse(result.stdout) as Array<[string, string[]]>);
}

function functionSwitchCaseLabels(file: string, functionName: string) {
    const text = readFileSync(file, "utf-8");
    const ast = parse(text, { ecmaVersion: "latest", sourceType: "module" });
    let functionNode: Record<string, unknown> | null = null;
    walkAst(ast, (node) => {
        if (functionNode || node.type !== "FunctionDeclaration") return;
        const id = node.id as Record<string, unknown> | undefined;
        if (id?.type === "Identifier" && id.name === functionName) functionNode = node;
    });
    expect(functionNode).not.toBeNull();
    const labels = new Set<string>();
    walkAst(functionNode, (node) => {
        if (node.type !== "SwitchCase") return;
        const test = node.test as Record<string, unknown> | undefined;
        if (test?.type === "Literal" && typeof test.value === "string") labels.add(String(test.value));
    });
    return [...labels].sort();
}

function deviceLabBackendHandlerCases() {
    const backendRoot = join(repoRoot, "device-lab-mcp", "src", "backends");
    return new Map([
        ["android-emulator", functionSwitchCaseLabels(join(backendRoot, "android.mjs"), "handleAndroidToolUnlocked")],
        ["android-device", functionSwitchCaseLabels(join(backendRoot, "android-device.mjs"), "handleAndroidRealToolUnlocked")],
        ["ios-simulator", functionSwitchCaseLabels(join(backendRoot, "ios-simulator.mjs"), "handleIosToolUnlocked")],
        ["ios-device", functionSwitchCaseLabels(join(backendRoot, "ios-device.mjs"), "handleIosRealToolUnlocked")],
        ["windows-sandbox", functionSwitchCaseLabels(join(backendRoot, "windows-sandbox.mjs"), "handleWindowsToolUnlocked")],
        ["macos-vm", functionSwitchCaseLabels(join(backendRoot, "macos-vm.mjs"), "handleMacosToolUnlocked")],
    ]);
}

function quotedSetConstant(text: string, name: string) {
    const match = new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\);`).exec(text);
    expect(match).not.toBeNull();
    return new Set([...(match?.[1] || "").matchAll(/"([^"]+)"/g)].map((item) => item[1]));
}

function quotedArrayConstant(text: string, name: string) {
    const match = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`).exec(text);
    expect(match).not.toBeNull();
    return new Set([...(match?.[1] || "").matchAll(/"([^"]+)"/g)].map((item) => item[1]));
}

function quotedMapKeys(text: string, name: string) {
    const match = new RegExp(`const ${name} = new Map\\(\\[([\\s\\S]*?)\\]\\);`).exec(text);
    expect(match).not.toBeNull();
    return new Set([...(match?.[1] || "").matchAll(/\["([^"]+)",\s*"[^"]+"\]/g)].map((item) => item[1]));
}

function backendAdvertisedSupportDrift() {
    const brokerText = readFileSync(join(repoRoot, "src", "device-lab-broker.ts"), "utf-8");
    const desktopCapabilities = quotedArrayConstant(brokerText, "DESKTOP_DEVICE_CAPABILITIES");
    const currentDisplayCapabilities = new Set([
        "device_status",
        "device_screenshot",
        "device_click",
        "device_double_click",
        "device_key",
        "device_type",
        "device_scroll",
        "device_cursor_position",
    ]);
    const capabilityCases = new Map([
        ["x11-current-display", currentDisplayCapabilities],
        ["android-emulator", quotedArrayConstant(brokerText, "ANDROID_EMULATOR_CAPABILITIES")],
        ["android-device", quotedArrayConstant(brokerText, "ANDROID_REAL_CAPABILITIES")],
        ["ios-simulator", quotedArrayConstant(brokerText, "IOS_SIMULATOR_CAPABILITIES")],
        ["ios-device", quotedArrayConstant(brokerText, "IOS_REAL_CAPABILITIES")],
        ["windows-sandbox", desktopCapabilities],
        ["macos-vm", new Set([...desktopCapabilities, ...quotedArrayConstant(brokerText, "MACOS_VM_CAPABILITIES")])],
    ]);
    const schemas = deviceLabToolBackendEnums();
    const backends = [...capabilityCases.keys()];
    const overAdvertised: Array<{ tool: string; backend: string; actual: string[] }> = [];
    const underAdvertised: Array<{ tool: string; backend: string; advertised: string[] }> = [];
    for (const [tool, advertised] of schemas.entries()) {
        if (advertised.length === 0 || tool.startsWith("device_broker_")) continue;
        const actual = backends.filter((backend) => capabilityCases.get(backend)?.has(tool));
        for (const backend of advertised) {
            if (!actual.includes(backend)) overAdvertised.push({ tool, backend, actual });
        }
        for (const backend of actual) {
            if (!advertised.includes(backend) && tool !== "device_wireless") underAdvertised.push({ tool, backend, advertised });
        }
    }
    return { overAdvertised, underAdvertised };
}

function hostBrokerBackendCapabilities() {
    const brokerText = readFileSync(join(repoRoot, "src", "device-lab-broker.ts"), "utf-8");
    const desktopCapabilities = quotedArrayConstant(brokerText, "DESKTOP_DEVICE_CAPABILITIES");
    return new Map([
        ["android-emulator", [...quotedArrayConstant(brokerText, "ANDROID_EMULATOR_CAPABILITIES")].sort()],
        ["android-device", [...quotedArrayConstant(brokerText, "ANDROID_REAL_CAPABILITIES")].sort()],
        ["ios-simulator", [...quotedArrayConstant(brokerText, "IOS_SIMULATOR_CAPABILITIES")].sort()],
        ["ios-device", [...quotedArrayConstant(brokerText, "IOS_REAL_CAPABILITIES")].sort()],
        ["windows-sandbox", [...desktopCapabilities].sort()],
        ["macos-vm", [...new Set([...desktopCapabilities, ...quotedArrayConstant(brokerText, "MACOS_VM_CAPABILITIES")])].sort()],
    ]);
}

function realTestFilesWithCallTool() {
    const root = join(repoRoot, "scripts", "real-tests");
    return readdirSync(root)
        .filter((file) => file.endsWith(".mjs"))
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
        for (const match of text.matchAll(/from\s+["']\.\/([^"']+\.mjs)["']/g)) {
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
    it("does not stop a pre-existing foreign Windows Sandbox session during single-use recovery", async () => {
        const foreignId = "11111111-1111-4111-8111-111111111111";
        const stopped: string[] = [];
        const runner = (_command: string, args: string[]) => {
            if (args[0] === "list") return { status: 0, stdout: JSON.stringify([{ id: foreignId }]), stderr: "" };
            if (args[0] === "stop") stopped.push(args[2]);
            return { status: 0, stdout: "", stderr: "" };
        };
        const callTool = async (tool: string) => {
            if (tool === "device_start") return mcpTextResult("CO_E_APPSINGLEUSE", true);
            return mcpTextResult({ device: { id: "windows-real-sandbox-test", status: "stopped" } });
        };

        await expect(startWindowsSandboxE2EDevice(callTool, "windows-real-sandbox-test", {
            wsb: "wsb",
            runner,
            retryDelayMs: 0,
        })).rejects.toThrow(/CO_E_APPSINGLEUSE/);
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
                    : [preExistingId, ownedId, concurrentForeignId];
                return { status: 0, stdout: JSON.stringify(ids.map((id) => ({ id }))), stderr: "" };
            }
            if (args[0] === "stop") stopped.push(args[2]);
            return { status: 0, stdout: "", stderr: "" };
        };
        let startCount = 0;
        const callTool = async (tool: string) => {
            if (tool === "device_status") {
                return mcpTextResult({ device: { id: "windows-real-sandbox-test", status: "running", sandboxId: ownedId } });
            }
            startCount += 1;
            return startCount === 1
                ? mcpTextResult("CO_E_APPSINGLEUSE", true)
                : mcpTextResult({ device: { id: "windows-real-sandbox-test", status: "running", sandboxId: ownedId } });
        };

        const started = await startWindowsSandboxE2EDevice(callTool, "windows-real-sandbox-test", {
            wsb: "wsb",
            runner,
            retryDelayMs: 0,
        });
        expect(started.device.sandboxId).toBe(ownedId);
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
            "src/__tests__/lab-mcp.real-linux-vm.test.ts",
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
        expect(level2.args.join("\n")).toContain("scripts/real-tests/run.mjs");
        expect(level2.args.join("\n")).toContain("scripts/real-tests/level0-package-smoke.mjs");
        expect(level2.args.join("\n")).toContain("scripts/real-tests/level1-real-provider-readiness.mjs");
        expect(level2.args.join("\n")).toContain("scripts/real-tests/level1-dist-real-provider-readiness.mjs");
        expect(level2.args.join("\n")).toContain("scripts/real-tests/level1-display-e2e.mjs");
        expect(level2.args.join("\n")).toContain("scripts/real-tests/level2-host-integration-slots.mjs");
        expect(level2.args.join("\n")).toContain("scripts/real-tests/level2-broker-e2e.mjs");
        expect(level2.args.join("\n")).toContain("scripts/real-tests/level2-dist-broker-e2e.mjs");
        expect(level2.args.join("\n")).toContain("scripts/real-tests/level2-ios-e2e.mjs");
        expect(level2.args.join("\n")).toContain("scripts/real-tests/level2-android-emulator-e2e.mjs");
        expect(level2.args.join("\n")).toContain("scripts/real-tests/level2-android-device-e2e.mjs");
        expect(level2.args.join("\n")).toContain("scripts/real-tests/level2-macos-vm-e2e.mjs");
        expect(level2.args.join("\n")).toContain("scripts/real-tests/level2-windows-sandbox.mjs");
        expect(level2.args.join("\n")).toContain("scripts/real-tests/level2-real-linux-vm.mjs");

        const level3 = dryRunNode("3");
        expect(level3.mode).toBe("node-test");
        expect(level3.args.join("\n")).toContain("scripts/real-tests/level0-package-smoke.mjs");
        expect(level3.args.join("\n")).toContain("scripts/real-tests/level1-dist-real-provider-readiness.mjs");
        expect(level3.args.join("\n")).toContain("scripts/real-tests/level2-broker-e2e.mjs");
        expect(level3.args.join("\n")).toContain("scripts/real-tests/level2-dist-broker-e2e.mjs");
        expect(level3.args.join("\n")).toContain("scripts/real-tests/level2-android-device-e2e.mjs");
        expect(level3.args.join("\n")).not.toContain("scripts/real-tests/level2-android-emulator-e2e.mjs");
        expect(level3.args.join("\n")).toContain("scripts/real-tests/level3-real-destructive.mjs");
    });

    it("always uses the current checkout CLI for real broker autolaunch", async () => {
        const { localCccPathEnv } = await import("../../scripts/real-tests/helpers.mjs") as {
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

    it("exposes only the four device-lab level commands", () => {
        const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8")) as {
            scripts?: Record<string, string>;
        };
        expect(pkg.scripts?.["test:level3"]).toBe("node scripts/real-tests/level3.mjs");
        expect(Object.keys(pkg.scripts || {}).filter((name) => name.startsWith("test:level"))).toEqual([
            "test:level0",
            "test:level1",
            "test:level2",
            "test:level3",
        ]);
    });

    it("treats the explicit Level 3 command as destructive authorization without an environment switch", () => {
        const level3Text = readFileSync(join(repoRoot, "scripts", "real-tests", "level3.mjs"), "utf-8");
        const vitestText = readFileSync(join(repoRoot, "scripts", "real-tests", "level3-vitest.mjs"), "utf-8");
        const configText = readFileSync(join(repoRoot, "scripts", "real-tests", "vitest.level3.config.mjs"), "utf-8");
        const destructiveText = readFileSync(join(repoRoot, "scripts", "real-tests", "level3-real-destructive.mjs"), "utf-8");
        expect(level3Text).toContain('vitest, "run", "--config", config');
        expect(level3Text).toContain("buildLevel3Artifacts()");
        expect(level3Text).toContain('"node_modules", "typescript", "bin", "tsc"');
        expect(vitestText).toMatch(/runner,\s*"3"/);
        expect(vitestText).toContain('"--platform-result"');
        expect(vitestText).toContain("for (const record of records)");
        expect(vitestText).toContain("for (const [index, record] of testRecords.entries())");
        expect(vitestText).toContain("it.skip");
        expect(vitestText).toContain('it("validates provider coverage matrix"');
        expect(vitestText).not.toContain('it("runs the real provider suite"');
        expect(vitestText).not.toContain('"--fail-on-coverage-gap"');
        expect(vitestText).toContain('key !== "VITEST" && !key.startsWith("VITEST_")');
        expect(configText).toContain('include: ["scripts/real-tests/level3-vitest.mjs"]');
        expect(configText).toContain("testTimeout: 30 * 60 * 1000");
        expect(destructiveText).toContain("destructive: true");
        expect(destructiveText).toContain("snapshot: true");
    });

    it("resolves the real-test repository root from Windows file URLs", async () => {
        const { repositoryRootFromModuleUrl } = await import("../../scripts/real-tests/helpers.mjs") as {
            repositoryRootFromModuleUrl: (moduleUrl: string, options?: { windows?: boolean }) => string;
        };
        const moduleUrl = "file:///C:/Users/TestUser/Project/_Project/claude-code-container/scripts/real-tests/helpers.mjs";

        expect(repositoryRootFromModuleUrl(moduleUrl, { windows: true })).toBe(
            "C:\\Users\\TestUser\\Project\\_Project\\claude-code-container\\",
        );
    });

    it("requires packaged real-provider evidence while retaining source and dist tool coverage", async () => {
        const { assertResultMatrix } = await import("../../scripts/real-tests/assert-matrix.mjs") as {
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
                advertisedTools: ["device_create"],
                calls: [
                    { file: "/results/provider-e2e.mjs", tool: "device_create", outcome: "ok", mcpSessionId: "source-session", facets: ["device_create:backend=test-provider"] },
                    { file: "/results/provider-e2e.mjs", tool: "device_create", outcome: "ok", mcpSessionId: "dist-session", facets: ["device_create:backend=test-provider"] },
                ],
            },
        };
        const options = {
            advertisedTools: ["device_create"],
            providerSpecs: [{ id: "test-provider", files: ["provider-e2e.mjs"], tools: ["device_create"] }],
            requireLinuxVm: false,
        };

        expect(assertResultMatrix([shard], options)).toEqual(expect.objectContaining({
            ok: true,
            failures: [],
            missingPublicDirectOkBySource: { source: [], dist: [] },
        }));

        const wrongFile = structuredClone(shard);
        wrongFile.toolCoverage.calls[1].file = "/results/level2-broker-e2e.mjs";
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
        expect(plan.args.join("\n")).toContain("scripts/real-tests/run.mjs");
        expect(plan.args.join("\n")).toContain("scripts/real-tests/level1-display-e2e.mjs");
    });

    it("runs device-lab real E2E operations through the MCP server instead of backend handlers", () => {
        for (const file of [
            "android-emulator-e2e.mjs",
            "ios-e2e.mjs",
            "windows-sandbox-e2e.mjs",
            "macos-vm-e2e.mjs",
        ]) {
            const text = readFileSync(join(repoRoot, "scripts", "real-tests", file), "utf-8");
            expect(text).toContain("withDeviceLabMcp");
            expect(text).not.toContain("CCC_DEVICE_LAB_OWNER_BASIS");
            expect(text).not.toMatch(/\bhandle(?:Android|Ios|IosReal|Windows|Macos)Tool\b/);
        }
        const helperText = readFileSync(join(repoRoot, "scripts", "real-tests", "device-lab-mcp-client.mjs"), "utf-8");
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

    it("keeps user-facing remediation on public device-lab tool names", () => {
        const brokerText = readFileSync(join(repoRoot, "src", "device-lab-broker.ts"), "utf-8");
        const mcpBrokerText = readFileSync(join(repoRoot, "device-lab-mcp", "src", "broker.mjs"), "utf-8");
        for (const hiddenName of [
            "device_broker_attach",
            "device_broker_apple",
        ]) {
            expect(brokerText).not.toMatch(new RegExp(`(?:Call|Re-run) ${hiddenName}\\b`));
            expect(mcpBrokerText).not.toContain(`${hiddenName} is`);
        }
        expect(brokerText).toContain("Call device_attach");
        expect(brokerText).toContain("Re-run device_wireless");
        expect(mcpBrokerText).not.toContain("device_broker_service");
    });

    it("keeps device-lab server literal tool sets deduplicated and advertised", () => {
        const advertised = new Set(advertisedDeviceLabTools());
        const setIssues = deviceLabServerLiteralSets().flatMap(({ name, values }) => {
            const duplicates = values.filter((value, index) => values.indexOf(value) !== index)
                .map((value) => ({ name, value, issue: "duplicate" }));
            const unadvertisedTools = values
                .filter((value) => /^(?:device|mobile|display)_/.test(value))
                .filter((value) => !advertised.has(value))
                .map((value) => ({ name, value, issue: "unadvertised-tool" }));
            return [...duplicates, ...unadvertisedTools];
        });
        expect(setIssues).toEqual([]);
    });

    it("keeps every advertised device-lab MCP tool on a server dispatch path", () => {
        const advertised = advertisedDeviceLabTools();
        const sets = new Map(deviceLabServerLiteralSets().map(({ name, values }) => [name, values]));
        const directlyHandled = [
            "device_backends",
            "device_broker_status",
            "device_list",
            "device_run_flow",
            "display_current",
            "mobile_run_flow",
        ];
        const routed = new Set([
            ...directlyHandled,
            ...(sets.get("BROKER_LIFECYCLE_COMMANDS") || []),
            ...(sets.get("BROKER_READONLY_DEVICE_TOOLS") || []),
            ...(sets.get("BROKER_MUTATING_DEVICE_TOOLS") || []),
            ...(sets.get("BROKER_PHYSICAL_TOOLS") || []),
            ...(sets.get("BROKER_MOBILE_ACTIONS") || []),
            ...deviceLabBackendCapabilityTools().flatMap(({ values }) => values),
        ]);
        const missing = advertised.filter((tool) => !routed.has(tool));
        const hiddenOrUnadvertised = [...routed]
            .filter((tool) => /^(?:device|mobile|display)_/.test(tool))
            .filter((tool) => !advertised.includes(tool) && !HIDDEN_COMPATIBILITY_TOOLS.has(tool));
        expect(missing).toEqual([]);
        expect(hiddenOrUnadvertised).toEqual([]);
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

    it("keeps MCP backend capabilities backed by concrete backend handler cases", () => {
        const capabilities = deviceLabMcpBackendCapabilities();
        const handlerCases = deviceLabBackendHandlerCases();
        const missing = [...capabilities.entries()].flatMap(([backend, tools]) => {
            const cases = handlerCases.get(backend) || [];
            return tools
                .filter((tool) => !cases.includes(tool))
                .map((tool) => ({ backend, tool }));
        });
        expect(missing).toEqual([]);
    });

    it("keeps provider real E2E scripts aligned with backend capability surfaces", () => {
        const capabilities = deviceLabMcpBackendCapabilities();
        const scripts = new Map<string, string>([
            ["android-emulator", "android-emulator-e2e.mjs"],
            ["android-device", "android-device-e2e.mjs"],
            ["ios-simulator", "ios-e2e.mjs"],
            ["ios-device", "ios-e2e.mjs"],
        ]);
        const expectedMissing = new Map<string, string[]>([
            ["android-emulator", []],
            ["android-device", []],
            ["ios-simulator", ["device_inventory"]],
            ["ios-device", ["device_inventory", "device_wireless"]],
        ]);
        const drift = [...scripts.entries()].flatMap(([backend, file]) => {
            const calls = realTestCallToolNamesForFile(file);
            const missing = (capabilities.get(backend) || [])
                .filter((tool) => !calls.has(tool))
                .sort();
            const expected = [...(expectedMissing.get(backend) || [])].sort();
            return JSON.stringify(missing) === JSON.stringify(expected)
                ? []
                : [{ backend, file, missing, expected }];
        });
        expect(drift).toEqual([]);
    });

    it("keeps backend handler-only tool cases explicitly classified", () => {
        const advertised = new Set(advertisedDeviceLabTools());
        const compatibility = new Set(HIDDEN_COMPATIBILITY_TOOLS);
        const capabilities = deviceLabMcpBackendCapabilities();
        const handlerCases = deviceLabBackendHandlerCases();
        const expected = new Map<string, string[]>([
            ["android-device", [
                "mobile_set_battery",
                "mobile_set_location",
                "mobile_set_network",
                "mobile_toggle_airplane_mode",
            ]],
            ["ios-simulator", [
                "mobile_back",
                "mobile_forward",
                "mobile_power",
                "mobile_recents",
                "mobile_set_battery",
                "mobile_set_network",
                "mobile_toggle_airplane_mode",
            ]],
            ["ios-device", [
                "device_exec",
                "mobile_back",
                "mobile_forward",
                "mobile_get_clipboard",
                "mobile_grant_permission",
                "mobile_open_url",
                "mobile_power",
                "mobile_recents",
                "mobile_revoke_permission",
                "mobile_set_battery",
                "mobile_set_clipboard",
                "mobile_set_location",
                "mobile_set_network",
                "mobile_toggle_airplane_mode",
                "mobile_uninstall_app",
            ]],
        ]);
        const actual = new Map([...handlerCases.entries()].map(([backend, cases]) => {
            const backendCapabilities = new Set(capabilities.get(backend) || []);
            return [backend, cases
                .filter((tool) => advertised.has(tool) || compatibility.has(tool))
                .filter((tool) => !backendCapabilities.has(tool))
                .sort()];
        }));
        expect([...actual.entries()].filter(([, tools]) => tools.length > 0)).toEqual([...expected.entries()]);
    });

    it("keeps hidden broker command forwarded lifecycle inputs explicit in the broker implementation", () => {
        const advertised = advertisedDeviceLabTools();
        expect(advertised).not.toContain("device_broker_command");
        const forwarded = new Set(brokerCommandForwardedInputKeys());
        const brokerText = readFileSync(join(repoRoot, "device-lab-mcp", "src", "broker.mjs"), "utf-8");
        expect(brokerText).toContain("...plainObject(options.options)");
        expect([...forwarded]).toEqual(expect.arrayContaining([
            "backend",
            "command",
            "deviceId",
            "name",
            "waitForBoot",
            "bootTimeoutMs",
            "dryRun",
            "force",
        ]));
    });

    it("keeps broker-routed device and mobile tool inputs forwarded through the broker device proxy", () => {
        const sets = new Map(deviceLabServerLiteralSets().map(({ name, values }) => [name, values]));
        const routedTools = new Set([
            ...(sets.get("BROKER_READONLY_DEVICE_TOOLS") || []),
            ...(sets.get("BROKER_MUTATING_DEVICE_TOOLS") || []),
            ...(sets.get("BROKER_MOBILE_ACTIONS") || []),
        ]);
        const forwarded = new Set(brokerDeviceToolForwardedInputKeys());
        const routeOnlyKeys = new Set([
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
            "backend",
            "appiumPort",
            "serverPort",
            "automationName",
            "provider",
            "physical",
        ]);
        const schemas = deviceLabToolSchemaPropertyMap();
        const missing = [...routedTools].flatMap((tool) => (schemas.get(tool) || [])
            .filter((key) => !routeOnlyKeys.has(key) && !forwarded.has(key))
            .map((key) => ({ tool, missing: key })));
        expect(missing).toEqual([]);

        const routedSchemaKeys = new Set([...routedTools].flatMap((tool) => schemas.get(tool) || []));
        const hidden = [...forwarded]
            .filter((key) => !routeOnlyKeys.has(key) && !routedSchemaKeys.has(key))
            .map((key) => ({ hidden: key }));
        expect(hidden).toEqual([]);
    });

    it("keeps every broker-routed mobile action mapped to a concrete execution path", () => {
        const sets = new Map(deviceLabServerLiteralSets().map(({ name, values }) => [name, values]));
        const actions = new Set(sets.get("BROKER_MOBILE_ACTIONS") || []);
        const backendProxyTools = new Set(sets.get("BROKER_BACKEND_MOBILE_TOOLS") || []);
        const appiumRequestTools = new Set(brokerMobileRequestToolKeys());
        const specialCases = new Set([
            "mobile_session_status",
            "mobile_wait_for_text",
        ]);
        const missing = [...actions]
            .filter((tool) => !backendProxyTools.has(tool) && !appiumRequestTools.has(tool) && !specialCases.has(tool));
        const staleBackendProxyTools = [...backendProxyTools].filter((tool) => !actions.has(tool));
        const staleAppiumRequestTools = [...appiumRequestTools].filter((tool) => !actions.has(tool));
        expect(missing).toEqual([]);
        expect(staleBackendProxyTools).toEqual([]);
        expect(staleAppiumRequestTools).toEqual([]);
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

    it("keeps MCP-generated broker Appium requests inside the host broker allowlist", () => {
        const allowed = new Set(hostBrokerAppiumAllowedRequests());
        const unsupported = mcpBrokerAppiumRequests()
            .filter((request) => !allowed.has(request))
            .map((request) => ({ request }));
        expect(unsupported).toEqual([]);
    });

    it("keeps hidden physical broker actions and forwarded inputs explicit in the implementation", () => {
        const advertised = advertisedDeviceLabTools();
        expect(advertised).not.toContain("device_broker_lease");
        expect(advertised).not.toContain("device_broker_attach");
        expect(advertised).not.toContain("device_broker_apple");
        expect(brokerWrapperActionKeys("brokerLease")).toEqual(["claim", "heartbeat", "list", "prune", "release"]);
        expect(brokerWrapperActionKeys("brokerPhysical")).toEqual(["attach", "detach", "list"]);
        expect(brokerAppleTrustActionKeys()).toEqual(["connect", "pair", "status"]);

        const checks = [
            { functionName: "brokerLease", expected: ["backend", "hardwareId", "deviceId", "connection", "ttlMs", "all"] },
            { functionName: "brokerPhysical", expected: ["backend", "name", "deviceId", "serial", "udid", "connection", "host", "devicePort"] },
            { functionName: "brokerApple", expected: ["backend", "udid"] },
        ];
        const missing = checks.flatMap(({ functionName, expected }) => {
            const forwarded = new Set(brokerWrapperForwardedInputKeys(functionName));
            return expected.filter((key) => !forwarded.has(key)).map((key) => ({ functionName, missing: key }));
        });
        expect(missing).toEqual([]);
    });

    it("keeps hidden broker RPC methods restricted to the runtime allowlist", () => {
        const advertised = advertisedDeviceLabTools();
        expect(advertised).not.toContain("device_broker_rpc");
        expect(publicBrokerRpcMethodKeys()).toEqual(["broker.backends", "broker.echo", "broker.inventory", "broker.status"]);
    });

    it("keeps device_run_flow free of tools that require destructive confirmation", () => {
        const sets = new Map(deviceLabServerLiteralSets().map(({ name, values }) => [name, values]));
        const deviceFlowTools = new Set([
            ...(sets.get("DEVICE_FLOW_ALLOWED_TOOLS") || []),
            ...(sets.get("DEVICE_FLOW_ALLOWED_MOBILE_TOOLS") || []),
        ]);
        const schemas = deviceLabToolSchemaPropertyMap();
        const confirmTools = [...schemas.entries()]
            .filter(([, properties]) => properties.includes("confirmDestructive"))
            .map(([name]) => name);
        const unsafe = confirmTools.filter((tool) => deviceFlowTools.has(tool));
        expect(unsafe).toEqual([]);
    });

    it("covers safe Android mobile controls in the real emulator E2E through MCP calls", () => {
        const text = readFileSync(join(repoRoot, "scripts", "real-tests", "android-emulator-e2e.mjs"), "utf-8");
        expect(text).toContain('}, providerMcpSessionOptions(options, "ccc-real-android-emulator-e2e"));');
        expect(text).not.toContain('new Promise((resolvePromise) => {\n        const server = createServer();\n        server.once("error", () => resolvePromise(false));\n        server.listen(port, "127.0.0.1", () => {\n            server.close(() => resolvePromise(true));\n        });\n    }, providerMcpSessionOptions');
        for (const tool of [
            "mobile_session_status",
            "mobile_dump_ui",
            "mobile_home",
            "mobile_tap",
            "mobile_double_tap",
            "mobile_long_press",
            "mobile_swipe",
            "mobile_drag",
            "mobile_type_text",
            "mobile_key",
            "mobile_back",
            "mobile_forward",
            "mobile_recents",
            "mobile_lock",
            "mobile_unlock",
            "mobile_rotate_left",
            "mobile_rotate_right",
            "mobile_set_orientation",
            "mobile_open_url",
            "mobile_set_location",
            "mobile_set_battery",
            "mobile_grant_permission",
            "mobile_revoke_permission",
            "mobile_wait_for_app",
            "device_record_video_start",
            "device_record_video_status",
            "device_record_video_stop",
            "mobile_run_flow",
            "mobile_screenshot",
            "mobile_set_clipboard",
            "mobile_get_clipboard",
            "device_upload",
            "device_download",
            "device_status",
        ]) {
            expect(text).toContain(`callTool("${tool}"`);
        }
    });

    it("covers destructive Android emulator controls only through the explicit level 3 path", () => {
        const level3 = dryRunNode("3");
        expect(level3.args.join("\n")).toContain("scripts/real-tests/level3-real-destructive.mjs");
        const destructiveText = readFileSync(join(repoRoot, "scripts", "real-tests", "level3-real-destructive.mjs"), "utf-8");
        const androidText = readFileSync(join(repoRoot, "scripts", "real-tests", "android-emulator-e2e.mjs"), "utf-8");
        expect(destructiveText).toContain("destructive: true");
        for (const tool of [
            "mobile_power",
            "mobile_set_network",
            "mobile_toggle_airplane_mode",
        ]) {
            expect(androidText).toContain(`callTool("${tool}"`);
        }
    });

    it("covers Android app install, launch, reset, and uninstall with a deterministic fixture or configured APK", () => {
        const text = readFileSync(join(repoRoot, "scripts", "real-tests", "android-emulator-e2e.mjs"), "utf-8");
        expect(text).toContain("CCC_REAL_ANDROID_APK");
        expect(text).toContain("CCC_REAL_ANDROID_PACKAGE");
        expect(text).toContain("CCC_REAL_ANDROID_PERMISSION");
        expect(text).toContain("materializeAndroidAppFixture(tempDir)");
        expect(text).toContain("appArtifact: \"verified\"");
        expect(text).toContain("appPermission: \"verified\"");
        for (const tool of [
            "device_install_app",
            "device_launch_app",
            "device_reset",
            "mobile_install_app",
            "mobile_launch_app",
            "mobile_uninstall_app",
            "mobile_clear_app_data",
            "device_upload",
            "device_download",
        ]) {
            expect(text).toContain(`callTool("${tool}"`);
        }
    });

    it("covers safe Android physical-device controls in the real-device E2E through MCP calls", () => {
        const text = readFileSync(join(repoRoot, "scripts", "real-tests", "android-device-e2e.mjs"), "utf-8");
        expect(text).toContain("CCC_REAL_ANDROID_DEVICE_SERIAL");
        expect(text).toContain("physical Android app proof unavailable before device mutation");
        expect(text).toContain("wirelessCoverage: \"status-actions-device verified\"");
        expect(text).not.toContain("if (appArtifactReady)");
        expect(text.indexOf("androidDeviceE2EPrerequisites()")).toBeLessThan(text.indexOf("mkdirSync(artifactRoot"));
        for (const tool of [
            "device_attach",
            "device_status",
            "device_start",
            "device_exec",
            "mobile_session_status",
            "mobile_dump_ui",
            "mobile_wait_for_text",
            "mobile_tap",
            "mobile_double_tap",
            "mobile_long_press",
            "mobile_swipe",
            "mobile_drag",
            "mobile_type_text",
            "mobile_key",
            "mobile_home",
            "mobile_back",
            "mobile_forward",
            "mobile_recents",
            "mobile_power",
            "mobile_lock",
            "mobile_unlock",
            "mobile_set_orientation",
            "mobile_rotate_left",
            "mobile_rotate_right",
            "mobile_open_url",
            "mobile_set_clipboard",
            "mobile_get_clipboard",
            "mobile_screenshot",
            "device_screenshot",
            "device_record_video_start",
            "device_record_video_status",
            "device_record_video_stop",
            "device_upload",
            "device_download",
            "device_install_app",
            "device_launch_app",
            "mobile_install_app",
            "mobile_launch_app",
            "mobile_wait_for_app",
            "mobile_grant_permission",
            "mobile_revoke_permission",
            "mobile_stop_app",
            "device_reset",
            "mobile_clear_app_data",
            "mobile_uninstall_app",
            "device_stop",
            "device_detach",
        ]) {
            expect(text).toContain(`callTool("${tool}"`);
        }
        expect(text).toContain("install-launch-wait-permission-stop-reset-clear-uninstall verified");
    });

    it("covers iOS Simulator app install, launch, reset, and uninstall when a disposable .app is configured", () => {
        const text = readFileSync(join(repoRoot, "scripts", "real-tests", "ios-e2e.mjs"), "utf-8");
        expect(text).toContain("CCC_REAL_IOS_SIMULATOR_APP");
        expect(text).toContain("CCC_REAL_IOS_SIMULATOR_BUNDLE_ID");
        expect(text).toContain("CCC_REAL_DEVICE_LAB_FAIL_ON_SKIP");
        expect(text).toContain("missing CCC_REAL_IOS_SIMULATOR_APP/CCC_REAL_IOS_SIMULATOR_BUNDLE_ID");
        expect(text).toContain("missing iOS Appium/XCUITest prerequisites");
        for (const tool of [
            "device_install_app",
            "device_launch_app",
            "device_reset",
            "mobile_install_app",
            "mobile_launch_app",
            "mobile_uninstall_app",
            "mobile_clear_app_data",
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

        const emulatorText = readFileSync(join(repoRoot, "scripts", "real-tests", "android-emulator-e2e.mjs"), "utf-8");
        expect(emulatorText.indexOf("androidEmulatorAppSelection()")).toBeLessThan(emulatorText.indexOf("mkdtempSync("));
    });

    it("covers safe iOS Simulator mobile controls in the real simulator E2E through MCP calls", () => {
        const text = readFileSync(join(repoRoot, "scripts", "real-tests", "ios-e2e.mjs"), "utf-8");
        for (const tool of [
            "mobile_session_status",
            "mobile_dump_ui",
            "mobile_tap",
            "mobile_double_tap",
            "mobile_long_press",
            "mobile_swipe",
            "mobile_drag",
            "mobile_home",
            "mobile_lock",
            "mobile_unlock",
            "mobile_rotate_left",
            "mobile_rotate_right",
            "mobile_set_orientation",
            "mobile_screenshot",
            "mobile_open_url",
            "mobile_stop_app",
            "mobile_set_location",
            "mobile_grant_permission",
            "mobile_revoke_permission",
            "mobile_set_clipboard",
            "mobile_get_clipboard",
            "mobile_wait_for_app",
            "device_record_video_start",
            "device_record_video_status",
            "device_record_video_stop",
            "device_status",
        ]) {
            expect(text).toContain(`callTool("${tool}"`);
        }
        expect(text).toContain("waitForSafari.running");
        expect(text).toContain("waitForInstalledApp.running");
    });

    it("covers safe iOS physical-device Appium controls in the real-device E2E through MCP calls", () => {
        const text = readFileSync(join(repoRoot, "scripts", "real-tests", "ios-e2e.mjs"), "utf-8");
        expect(text).toContain("CCC_REAL_IOS_DEVICE_BUNDLE_ID");
        expect(text).toContain("CCC_REAL_DEVICE_LAB_FAIL_ON_SKIP");
        expect(text).toContain("missing iOS real-device Appium/XCUITest prerequisites");
        for (const tool of [
            "mobile_session_status",
            "mobile_dump_ui",
            "mobile_screenshot",
            "mobile_tap",
            "mobile_double_tap",
            "mobile_long_press",
            "mobile_swipe",
            "mobile_drag",
            "mobile_type_text",
            "mobile_key",
            "mobile_home",
            "mobile_lock",
            "mobile_unlock",
            "mobile_rotate_left",
            "mobile_rotate_right",
            "mobile_set_orientation",
            "mobile_wait_for_text",
            "mobile_install_app",
            "mobile_launch_app",
            "mobile_wait_for_app",
            "mobile_stop_app",
        ]) {
            expect(text).toContain(`callTool("${tool}"`);
        }
        expect(text).toContain("appiumControls = \"verified\"");
        expect(text).toContain("appCoverage = appArtifactReady ? \"install-launch-wait-stop verified\" : \"launch-wait-stop verified\"");
    });

    it("covers macOS VM snapshot restore in the destructive real E2E path", () => {
        const text = readFileSync(join(repoRoot, "scripts", "real-tests", "macos-vm-e2e.mjs"), "utf-8");
        for (const tool of [
            "device_snapshot_create",
            "device_snapshot_restore",
            "device_snapshot_delete",
        ]) {
            expect(text).toContain(`callTool("${tool}"`);
        }
        expect(text).toContain("options.snapshot === true");
    });

    it("covers the current X11 display tools in a real MCP E2E", () => {
        const level1 = dryRunNode("1");
        expect(level1.args.join("\n")).toContain("scripts/real-tests/level1-display-e2e.mjs");
        const text = readFileSync(join(repoRoot, "scripts", "real-tests", "level1-display-e2e.mjs"), "utf-8");
        for (const tool of [
            "display_current",
            "display_screenshot",
            "display_click",
            "display_double_click",
            "display_key",
            "display_type",
            "display_scroll",
            "display_cursor_position",
            "device_list",
            "device_status",
            "device_screenshot",
            "device_click",
            "device_double_click",
            "device_key",
            "device_type",
            "device_scroll",
            "device_cursor_position",
            "device_run_flow",
        ]) {
            expect(text).toContain(`"${tool}"`);
        }
        expect(text).toContain("withDeviceLabMcp");
        expect(text).toContain("\"left\", \"right\"");
        expect(text).toContain("\"up\", \"down\", \"left\", \"right\"");
        expect(text).toContain("device_list includes current display");
        expect(text).toContain("device_status current display alias");
        expect(text).toContain("device_cursor_position current display alias");
        expect(text).toContain("display_click buttons");
        expect(text).toContain("display_double_click buttons");
        expect(text).toContain("display_scroll directions");
        expect(text).toContain("device_click current display alias buttons");
        expect(text).toContain("device_double_click current display alias buttons");
        expect(text).toContain("device_scroll current display alias directions");
    });

    it("covers safe desktop read-only tools in Windows and macOS real E2E through MCP calls", () => {
        for (const file of ["windows-sandbox-e2e.mjs", "macos-vm-e2e.mjs"]) {
            const text = readFileSync(join(repoRoot, "scripts", "real-tests", file), "utf-8");
            for (const tool of [
                "device_click",
                "device_double_click",
                "device_key",
                "device_type",
                "device_scroll",
                "device_window_list",
                "device_cursor_position",
                "device_accessibility_snapshot",
                "device_record_video_status",
            ]) {
                expect(text).toContain(`callTool("${tool}"`);
            }
        }
        const windowsText = readFileSync(join(repoRoot, "scripts", "real-tests", "windows-sandbox-e2e.mjs"), "utf-8");
        expect(windowsText).toContain("status.device.sandboxId");
        expect(windowsText).toContain("upload.uploaded.remotePath");
        expect(windowsText).toContain("download.downloaded.localPath");

        const macosText = readFileSync(join(repoRoot, "scripts", "real-tests", "macos-vm-e2e.mjs"), "utf-8");
        expect(macosText).toContain("upload.provider");
        expect(macosText).toContain("download.provider");
        expect(macosText).toContain("upload.uploaded.remotePath");
        expect(macosText).toContain("download.downloaded.localPath");
    });

    it("covers physical wireless status and safe action diagnostics in real MCP readiness", () => {
        const text = readFileSync(join(repoRoot, "scripts", "real-tests", "level1-real-provider-readiness.mjs"), "utf-8");
        expect(text).toContain("device_wireless");
        expect(text).toContain("action: \"status\"");
        expect(text).toContain("\"usb-tcpip\", \"pair\", \"connect\"");
        expect(text).toContain("android-wireless-missing-adb");
        expect(text).toContain("android-wireless-usb-tcpip-requires-serial");
        expect(text).toContain("android-wireless-pair-requires-host-port-code");
        expect(text).toContain("android-wireless-connect-requires-host");
        expect(text).toContain("ios-wireless-missing-xcrun");
        expect(text).toContain("ios-wireless-pairing-requires-xcode-trust");
        expect(text).toContain("Android physical wireless action diagnostics MCP");
        expect(text).toContain("iOS physical wireless action diagnostics MCP");
    });

    it("covers broker autolaunch and broker-backed provider discovery in the real MCP E2E", () => {
        const text = readFileSync(join(repoRoot, "scripts", "real-tests", "level2-broker-e2e.mjs"), "utf-8");
        const distText = readFileSync(join(repoRoot, "scripts", "real-tests", "level2-dist-broker-e2e.mjs"), "utf-8");
        const helperText = readFileSync(join(repoRoot, "scripts", "real-tests", "helpers.mjs"), "utf-8");
        expect(text).toContain("device_broker_status");
        expect(text).toContain("device_broker_rpc");
        expect(text).toContain("broker.echo");
        expect(text).toContain("broker.status");
        expect(text).toContain("broker.inventory");
        expect(text).toContain("broker.backends");
        expect(text).toContain("broker RPC status");
        expect(text).toContain("broker RPC inventory");
        expect(text).toContain("device_backends");
        expect(text).toContain("action: \"status\"");
        expect(text).toContain("action: \"claim\"");
        expect(text).toContain("action: \"heartbeat\"");
        expect(text).toContain("action: \"prune\"");
        expect(text).toContain("action: \"release\"");
        expect(text).toContain("broker lease claim heartbeat prune release");
        expect(text).toContain("action: \"attach\"");
        expect(text).toContain("action: \"detach\"");
        expect(text).toContain("broker physical attach missing-device diagnostic");
        expect(text).toContain("broker physical detach missing-device diagnostic");
        expect(text).toContain("action: \"pair\"");
        expect(text).toContain("action: \"connect\"");
        expect(text).toContain("broker Apple trust pair diagnostic");
        expect(text).toContain("broker Apple trust connect diagnostic");
        expect(text).toContain("action: \"list\"");
        expect(text).toContain("action: \"record\"");
        expect(text).toContain("action: \"clear\"");
        expect(text).toContain("broker Appium session list");
        expect(text).toContain("broker Appium record missing-device diagnostic");
        expect(text).toContain("broker Appium clear missing-device diagnostic");
        expect(text).toContain("\"start\", \"stop\", \"ensure-session\", \"delete-session\"");
        expect(text).toContain("broker Appium lifecycle/session missing-device diagnostics");
        expect(text).toContain("action: \"request\"");
        expect(text).toContain("\"GET\", \"POST\"");
        expect(text).toContain("broker Appium request method diagnostics");
        expect(text).toContain("action: \"invoke\"");
        expect(text).toContain("broker lifecycle command invoke missing-device diagnostic");
        expect(text).toContain("\"device_create\", \"device_status\", \"device_start\", \"device_stop\", \"device_delete\"");
        expect(text).toContain("broker lifecycle command plan enum diagnostics");
        expect(text).toContain("broker lifecycle command options flattening");
        expect(text).toContain("devicePort: 5598");
        expect(text).toContain("autolaunch: true");
        expect(text).toContain("ccc-broker-e2e-home-");
        expect(text).toContain("HOME: testHome");
        expect(text).toContain("USERPROFILE: testHome");
        expect(text).toContain("brokerPort: port");
        expect(text).toContain("rmSync(testHome, { recursive: true, force: true })");
        expect(text).toContain("cleanupTestBrokerRuntime");
        expect(text).toContain("stopWindowsTestBroker");
        expect(text).toContain('spawnSync("taskkill"');
        expect(text).toContain("waitForPidExit");
        expect(text).toContain("ccc.cleanup?.()");
        expect(text).toContain("runtimeRemoved=");
        expect(text).toContain("exited=");
        expect(text).toContain("Windows test broker process cleanup");
        expect(text).not.toContain("cleanupOwner: false");
        expect(text).toContain("broker lifecycle remains session-owned");
        expect(text).toContain("reused or host-managed broker remains running");
        expect(text).not.toContain("so shutdown would affect a shared broker");
        expect(helperText).toContain("ccc-real-tests-bin-");
        expect(helperText).toContain("cleanup: () => rmSync");
        expect(text).not.toContain("CCC_DEVICE_LAB_OWNER_BASIS");
        expect(text).not.toContain("implicitBroker: false");
        expect(text).toContain("export async function runBrokerE2E(options = {})");
        expect(distText).toContain("runBrokerE2E");
        expect(distText).toContain("dist\", \"device-lab-mcp\", \"server.mjs");
    });

    it("runs available real-provider E2E scenarios through source and packaged MCP servers", () => {
        const matrixText = readFileSync(join(repoRoot, "scripts", "real-tests", "provider-mcp-matrix.mjs"), "utf-8");
        const readinessText = readFileSync(join(repoRoot, "scripts", "real-tests", "level1-dist-real-provider-readiness.mjs"), "utf-8");
        const coreFiles = [
            "android-emulator-e2e.mjs",
            "android-device-e2e.mjs",
            "ios-e2e.mjs",
            "macos-vm-e2e.mjs",
            "windows-sandbox-e2e.mjs",
        ];
        const levelFiles = [
            "level2-android-emulator-e2e.mjs",
            "level2-android-device-e2e.mjs",
            "level2-ios-e2e.mjs",
            "level2-macos-vm-e2e.mjs",
            "level2-windows-sandbox.mjs",
            "level3-real-destructive.mjs",
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
        const { runProviderMcpMatrix } = await import("../../scripts/real-tests/provider-mcp-matrix.mjs") as {
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
        const { runProviderMcpMatrix } = await import("../../scripts/real-tests/provider-mcp-matrix.mjs") as {
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
        const { aggregateStepResult } = await import("../../scripts/real-tests/result-status.mjs") as {
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
        const unadvertised = [...calledTools].filter((tool) => !advertised.includes(tool) && !HIDDEN_COMPATIBILITY_TOOLS.has(tool));
        expect(missing).toEqual(intentionallyNotSafeInGenericRealE2E);
        expect(unadvertised).toEqual([]);
    });

    it("keeps provider real E2E scripts on public device-lab MCP tool names", () => {
        const hiddenProviderCalls = realTestCallToolArgumentKeys()
            .filter((call) => call.file !== "level2-broker-e2e.mjs")
            .filter((call) => HIDDEN_COMPATIBILITY_TOOLS.has(call.tool));
        expect(hiddenProviderCalls).toEqual([]);
    });

    it("keeps provider real E2E scripts free of hidden broker transport arguments", () => {
        const hiddenProviderArgs = realTestCallToolArgumentKeys()
            .filter((call) => call.file !== "level2-broker-e2e.mjs")
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
            if (HIDDEN_COMPATIBILITY_TOOLS.has(call.tool)) return [];
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
        expect([...ALWAYS_DESTRUCTIVE_REAL_E2E_TOOLS].sort()).toEqual(expect.arrayContaining(alwaysDestructivePolicyTools()));
        expect(realTestDestructiveCallsMissingConfirmation()).toEqual([]);
    });

    it("keeps every real E2E MCP call reachable from the level 3 node runner", () => {
        const plan = dryRunNode("3");
        const entryFiles = plan.args
            .filter((arg) => arg.includes("/scripts/real-tests/") && arg.endsWith(".mjs"))
            .map((arg) => arg.split("/scripts/real-tests/")[1])
            .filter((file) => file !== "run.mjs");
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
            writeFileSync(passFile, "export const name='pass'; export async function run(){ return { status: 'PASS', detail: 'provider=tart' }; }\n");
            writeFileSync(stepFailFile, "export const name='step-fail'; export async function run(){ return { status: 'FAIL', steps: [{ name: 'inner', status: 'FAIL', reason: 'boom', detail: 'device=abc' }] }; }\n");

            const result = spawnSync(process.execPath, [join(repoRoot, "scripts", "real-tests", "run.mjs"), passFile, stepFailFile], {
                cwd: repoRoot,
                encoding: "utf-8",
            });

            expect(result.status).toBe(1);
            expect(result.stdout).toContain("PASS pass (provider=tart)");
            expect(result.stdout).toContain("FAIL step-fail: inner - boom (device=abc)");
            expect(result.stdout).toContain("SUMMARY real-tests total=2 pass=1 skip=0 fail=1 failOnSkip=false");
            expect(result.stdout).not.toContain("strictSkipFailures");

            const compactResult = spawnSync(process.execPath, [join(repoRoot, "scripts", "real-tests", "run.mjs"), "--compact", passFile, stepFailFile], {
                cwd: repoRoot,
                encoding: "utf-8",
            });
            expect(compactResult.status).toBe(1);
            expect(compactResult.stdout).not.toContain("PASS pass");
            expect(compactResult.stdout).toContain("FAIL step-fail: inner - boom");
            expect(compactResult.stdout).toContain("SUMMARY real-tests total=2 pass=1 skip=0 fail=1 failOnSkip=false");
        } finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it("fails closed when real-test results omit or invent statuses", () => {
        const tempDir = mkdtempSync(join(tmpdir(), "ccc-real-test-runner-"));
        try {
            const missingResultStatus = join(tempDir, "missing-result-status.mjs");
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
                join(repoRoot, "scripts", "real-tests", "run.mjs"),
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

            const defaultResult = spawnSync(process.execPath, [join(repoRoot, "scripts", "real-tests", "run.mjs"), skipFile, stepSkipFile], {
                cwd: repoRoot,
                encoding: "utf-8",
            });
            expect(defaultResult.status).toBe(0);
            expect(defaultResult.stdout).toContain("SUMMARY real-tests total=2 pass=0 skip=2 fail=0 failOnSkip=false");
            expect(defaultResult.stdout).not.toContain("strictSkipFailures");
            expect(defaultResult.stdout).not.toContain("strictCoverageFailures");

            const strictResult = spawnSync(process.execPath, [join(repoRoot, "scripts", "real-tests", "run.mjs"), "--fail-on-skip", skipFile, stepSkipFile], {
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
                "  const skipped = () => callTool(\"mobile_set_battery\", { backend: \"android-emulator\", deviceId: \"skipped-device\", level: 77, charging: true, confirmDestructive: true });",
                "  void skipped;",
                "  return { status: 'SKIP', reason: 'missing adb, emulator' };",
                "}",
                "",
            ].join("\n"));

            const result = spawnSync(process.execPath, [join(repoRoot, "scripts", "real-tests", "run.mjs"), "--json-summary-file", summaryFile, skippedFile], {
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
                "  const never = () => callTool(\"device_backends\", { backend: \"android-emulator\" });",
                "  void never;",
                "  return { status: 'PASS', tools: ['device_backends'] };",
                "}",
                "",
            ].join("\n"));

            const defaultResult = spawnSync(process.execPath, [join(repoRoot, "scripts", "real-tests", "run.mjs"), scriptedButUncalledFile], {
                cwd: repoRoot,
                encoding: "utf-8",
            });
            expect(defaultResult.status).toBe(0);
            expect(defaultResult.stdout).toContain("SUMMARY real-tests total=1 pass=1 skip=0 fail=0 failOnSkip=false");
            expect(defaultResult.stdout).not.toContain("strictCoverageFailures");

            const strictResult = spawnSync(process.execPath, [join(repoRoot, "scripts", "real-tests", "run.mjs"), "--fail-on-coverage-gap", scriptedButUncalledFile], {
                cwd: repoRoot,
                encoding: "utf-8",
            });
            expect(strictResult.status).toBe(1);
            expect(strictResult.stdout).toContain("SUMMARY real-tests total=1 pass=1 skip=0 fail=0 failOnSkip=false strictCoverageFailures=82");
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
                "  const scripted = () => callTool(\"mobile_set_battery\", { backend: \"android-emulator\", deviceId: \"facet-device\", level: 42, status: 2, charging: true, confirmDestructive: true });",
                "  void scripted;",
                "  const key = Symbol.for('ccc.deviceLabRealTests.toolCalls');",
                "  globalThis[key] = [{ name: 'mobile_set_battery', arguments: { backend: 'android-emulator', deviceId: 'facet-device', level: 42, status: 2, charging: true, confirmDestructive: true }, outcome: 'ok', isError: false }];",
                "  return { status: 'PASS' };",
                "}",
                "",
            ].join("\n"));

            const result = spawnSync(process.execPath, [join(repoRoot, "scripts", "real-tests", "run.mjs"), "--json-summary-file", summaryFile, facetFile], {
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
                "mobile_set_battery:backend=android-emulator",
                "mobile_set_battery:charging=true",
                "mobile_set_battery:confirmDestructive=true",
                "mobile_set_battery:level=42",
                "mobile_set_battery:status=2",
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
                "  globalThis[key] = [{ name: 'display_click', arguments: { x: 1, y: 1, button: 'left' }, outcome: 'ok', isError: false }];",
                "  return { status: 'PASS' };",
                "}",
                "",
            ].join("\n"));

            const result = spawnSync(process.execPath, [join(repoRoot, "scripts", "real-tests", "run.mjs"), "--json-summary-file", summaryFile, facetFile], {
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
                "display_click:button=left",
                "display_click:button=right",
                "mobile_set_orientation:orientation=reverse-landscape",
            ]));
            expect(summary.toolCoverage.calledAdvertisedArgumentEnumFacets).toContain("display_click:button=left");
            expect(summary.toolCoverage.uncalledAdvertisedArgumentEnumFacets).toContain("display_click:button=right");
            expect(summary.toolCoverage.uncalledAdvertisedArgumentEnumFacets).not.toContain("display_click:button=left");
            expect(summary.toolCoverage.uncalledProviderArgumentEnumFacets).toEqual(expect.arrayContaining([
                "device_status:backend=android-emulator",
                "device_create:provider=auto",
            ]));
            expect(summary.toolCoverage.uncalledNonProviderArgumentEnumFacets).toContain("display_click:button=right");
            expect(summary.toolCoverage.uncalledNonProviderArgumentEnumFacets).not.toContain("device_status:backend=android-emulator");
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
                "  globalThis[key] = [{ name: 'mobile_toggle_airplane_mode', arguments: { backend: 'android-emulator', deviceId: 'facet-device', enabled: false, confirmDestructive: true }, outcome: 'ok', isError: false }];",
                "  return { status: 'PASS', scriptedArgumentFacets: ['mobile_toggle_airplane_mode:enabled=false', 'mobile_toggle_airplane_mode:confirmDestructive=true'] };",
                "}",
                "",
            ].join("\n"));

            const result = spawnSync(process.execPath, [join(repoRoot, "scripts", "real-tests", "run.mjs"), "--json-summary-file", summaryFile, facetFile], {
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
                "mobile_toggle_airplane_mode:enabled=false",
                "mobile_toggle_airplane_mode:confirmDestructive=true",
            ]));
            expect(summary.toolCoverage.invalidScriptedArgumentFacets).toEqual([]);
            expect(summary.toolCoverage.uncalledScriptedArgumentFacets).toEqual([]);
            expect(summary.toolCoverage.scripted).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    source: "declared-scripted-argument-facet",
                    facets: ["mobile_toggle_airplane_mode:enabled=false"],
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
                "  return { status: 'PASS', scriptedArgumentFacets: ['display_click:bogus=left', 'missing_tool:button=left', 'not-a-facet'] };",
                "}",
                "",
            ].join("\n"));

            const result = spawnSync(process.execPath, [join(repoRoot, "scripts", "real-tests", "run.mjs"), "--fail-on-coverage-gap", "--json-summary-file", summaryFile, facetFile], {
                cwd: repoRoot,
                encoding: "utf-8",
            });
            expect(result.status).toBe(1);
            expect(result.stdout).toContain("strictCoverageFailures=89");
            const summary = JSON.parse(readFileSync(summaryFile, "utf-8")) as {
                toolCoverage: {
                    invalidScriptedArgumentFacets: string[];
                };
            };
            expect(summary.toolCoverage.invalidScriptedArgumentFacets).toEqual([
                "display_click:bogus=left",
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
                "  globalThis[key] = [{ name: 'display_current', arguments: {}, outcome: 'thrown', error: 'boom' }];",
                "  return { status: 'PASS', scriptedTools: ['display_current'] };",
                "}",
                "",
            ].join("\n"));

            const result = spawnSync(process.execPath, [join(repoRoot, "scripts", "real-tests", "run.mjs"), "--fail-on-coverage-gap", outcomeFile], {
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
                "  globalThis[key] = [{ name: 'display_current', arguments: {}, outcome: 'error-result', isError: true }];",
                "  return { status: 'PASS', scriptedTools: ['display_current'] };",
                "}",
                "",
            ].join("\n"));

            const result = spawnSync(process.execPath, [join(repoRoot, "scripts", "real-tests", "run.mjs"), "--fail-on-coverage-gap", outcomeFile], {
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
                "  globalThis[key] = [{ name: 'display_current', arguments: {}, outcome: 'ok', isError: false, okPayloadText: true, okPayloadJson: false, okPayloadImage: false }];",
                "  return { status: 'PASS', scriptedTools: ['display_current'] };",
                "}",
                "",
            ].join("\n"));

            const result = spawnSync(process.execPath, [join(repoRoot, "scripts", "real-tests", "run.mjs"), "--fail-on-coverage-gap", outcomeFile], {
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
                "  globalThis[key].push({ name: 'display_current', mcpSessionId: 'fixture-session-1', arguments: {}, outcome: 'ok', isError: false, okPayloadText: true, okPayloadJson: true, okPayloadImage: false });",
                "  globalThis[key].push({ name: 'device_broker_rpc', mcpSessionId: 'fixture-session-1', arguments: { method: 'broker.status' }, outcome: 'error-result', isError: true, expectedError: true, errorPayloadJson: true, errorCode: 'broker-unavailable' });",
                "  globalThis[key].push({ name: 'device_run_flow', mcpSessionId: 'fixture-session-1', arguments: { steps: [{ tool: 'display_current', arguments: {} }] }, outcome: 'ok', isError: false, okPayloadText: true, okPayloadJson: true, okPayloadImage: false, flowSteps: [{ tool: 'display_current', isError: false, expectedError: false, okPayloadJson: true, okPayloadImage: false }] });",
                "  return { status: 'PASS', detail: 'provider=display', scriptedTools: ['display_current', 'device_broker_rpc', 'device_run_flow'] };",
                "}",
                "",
            ].join("\n"));
            writeFileSync(stepSkipFile, "export const name='step-skip'; export async function run(){ return { status: 'SKIP', steps: [{ name: 'inner', status: 'SKIP', reason: 'missing adb', detail: 'backend=android-device' }] }; }\n");

            const result = spawnSync(process.execPath, [join(repoRoot, "scripts", "real-tests", "run.mjs"), "--fail-on-skip", "--json-summary", "--json-summary-file", summaryFile, passFile, stepSkipFile], {
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
                    calledHiddenCompatibilityTools: string[];
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
                    scriptedHiddenCompatibilityTools: string[];
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
                expect.objectContaining({ test: "pass", status: "PASS", detail: "provider=display", tools: ["device_broker_rpc", "device_run_flow", "display_current"] }),
                expect.objectContaining({ test: "step-skip", step: "inner", status: "SKIP", reason: "missing adb", detail: "backend=android-device" }),
            ]);
            expect(summary.skipCategories).toEqual([
                {
                    category: "provider-prerequisite",
                    count: 1,
                    records: [{ test: "step-skip", step: "inner", reason: "missing adb" }],
                },
            ]);
            expect(summary.toolCoverage.calledTools).toEqual(["device_broker_rpc", "device_run_flow", "display_current"]);
            expect(summary.toolCoverage.canonicalToolSurface).toEqual(canonicalDeviceLabToolSurface());
            expect(summary.toolCoverage.calledPublicTools).toEqual(["device_run_flow", "display_current"]);
            expect(summary.toolCoverage.calledHiddenCompatibilityTools).toEqual(["device_broker_rpc"]);
            expect(summary.toolCoverage.calledArgumentFacets).toEqual(["device_broker_rpc:method=broker.status"]);
            expect(summary.toolCoverage.callOutcomes).toEqual({ "error-result": 1, ok: 2 });
            expect(summary.toolCoverage.toolOutcomeSummary).toEqual(expect.objectContaining({
                display_current: expect.objectContaining({ ok: 1, expectedError: 0 }),
                device_broker_rpc: expect.objectContaining({ ok: 0, expectedError: 1 }),
            }));
            expect(summary.toolCoverage.toolEvidenceSummary.display_current.evidence).toEqual(["direct-ok", "flow-ok"]);
            expect(summary.toolCoverage.publicToolsWithoutEvidence).toEqual([]);
            expect(summary.toolCoverage.publicToolsWithoutDirectOk).toEqual([]);
            expect(summary.toolCoverage.publicToolsWithOnlyExpectedErrorEvidence).toEqual([]);
            expect(summary.toolCoverage.unexplainedDiagnosticOnlyTools).toEqual([]);
            expect(summary.toolCoverage.unjustifiedMissingDirectOkTools).toEqual([]);
            expect(summary.toolCoverage.explainedProviderValues).toEqual([]);
            expect(summary.toolCoverage.unexplainedProviderArgumentEnumFacets).toEqual(expect.arrayContaining([
                "device_create:backend=android-emulator",
                "device_create:provider=tart",
            ]));
            expect(summary.toolCoverage.publicToolsWithoutOkOrExpectedError).toEqual([]);
            expect(summary.toolCoverage.scriptedTools).toEqual(["device_broker_rpc", "device_run_flow", "display_current"]);
            expect(summary.toolCoverage.scriptedPublicTools).toEqual(["device_run_flow", "display_current"]);
            expect(summary.toolCoverage.scriptedHiddenCompatibilityTools).toEqual(["device_broker_rpc"]);
            expect(summary.toolCoverage.scriptedArgumentFacets).toEqual([]);
            expect(summary.toolCoverage.uncalledScriptedTools).toEqual([]);
            expect(summary.toolCoverage.uncalledScriptedArgumentFacets).toEqual([]);
            expect(summary.toolCoverage.unadvertisedTools).toEqual([]);
            expect(summary.toolCoverage.argumentSchemaFailureRecords).toEqual([]);
            expect(summary.toolCoverage.flowStepArgumentSchemaFailures).toEqual([]);
            expect(summary.toolCoverage.expectedErrorResultRecords).toEqual([
                expect.objectContaining({ test: "pass", tool: "device_broker_rpc", expectedError: true, errorPayloadJson: true, errorCode: "broker-unavailable" }),
            ]);
            expect(summary.toolCoverage.expectedErrorPayloadFailures).toEqual([]);
            expect(summary.toolCoverage.okPublicPayloadFailures).toEqual([]);
            expect(summary.toolCoverage.emptyOkPublicPayloadRecords).toEqual([]);
            expect(summary.toolCoverage.flowStepOutcomeSummary).toEqual({
                display_current: { total: 1, ok: 1, error: 0 },
            });
            expect(summary.toolCoverage.flowStepToolOutcomeSummary).toEqual({
                display_current: { total: 1, ok: 1, expectedError: 0, unexpectedError: 0 },
            });
            expect(summary.toolCoverage.publicFlowStepTools).toEqual(["display_current"]);
            expect(summary.toolCoverage.publicFlowStepToolsWithoutOkOrExpectedError).toEqual([]);
            expect(summary.toolCoverage.expectedFlowStepErrorRecords).toEqual([]);
            expect(summary.toolCoverage.unexpectedFlowStepErrorRecords).toEqual([]);
            expect(summary.toolCoverage.expectedFlowStepPayloadFailures).toEqual([]);
            expect(summary.toolCoverage.okPublicFlowStepPayloadFailures).toEqual([]);
            expect(summary.toolCoverage.emptyOkPublicFlowStepPayloadRecords).toEqual([]);
            expect(summary.toolCoverage.calls).toEqual([
                expect.objectContaining({ test: "pass", tool: "display_current", mcpSessionId: "fixture-session-1", schemaValid: true }),
                expect.objectContaining({ test: "pass", tool: "device_broker_rpc", mcpSessionId: "fixture-session-1", schemaValid: true }),
                expect.objectContaining({ test: "pass", tool: "device_run_flow", mcpSessionId: "fixture-session-1", schemaValid: true }),
            ]);
            expect(summary.toolCoverage.scripted).toEqual([
                expect.objectContaining({ test: "pass", tool: "display_current", source: "declared-scripted-result" }),
                expect.objectContaining({ test: "pass", tool: "device_broker_rpc", source: "declared-scripted-result" }),
                expect.objectContaining({ test: "pass", tool: "device_run_flow", source: "declared-scripted-result" }),
            ]);
            expect(summary.mcpSessions).toEqual([
                expect.objectContaining({ test: "pass", id: "fixture-session-1", name: "fixture-session", serverPath: "/tmp/device-lab-mcp/server.mjs", serverSource: "source" }),
            ]);
            expect(JSON.parse(readFileSync(summaryFile, "utf-8"))).toEqual(summary);
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
                    advertisedTools: ["device_backends", "display_current"],
                    calledTools: ["device_broker_rpc", "display_current"],
                    calledPublicTools: ["display_current"],
                    calledHiddenCompatibilityTools: ["device_broker_rpc"],
                    calledArgumentFacets: ["device_broker_rpc:method=broker.status"],
                    callOutcomes: { "error-result": 1, ok: 1 },
                    toolOutcomeSummary: {
                        display_current: { total: 1, ok: 1, expectedError: 0, unexpectedError: 0, incomplete: 0 },
                        device_broker_rpc: { total: 1, ok: 0, expectedError: 1, unexpectedError: 0, incomplete: 0 },
                    },
                    toolEvidenceSummary: {
                        display_current: { direct: { total: 1, ok: 1, expectedError: 0, unexpectedError: 0, incomplete: 0 }, flow: { total: 1, ok: 1, expectedError: 0, unexpectedError: 0 }, evidence: ["direct-ok", "flow-ok"] },
                        device_backends: { direct: { total: 0, ok: 0, expectedError: 0, unexpectedError: 0, incomplete: 0 }, flow: { total: 0, ok: 0, expectedError: 0, unexpectedError: 0 }, evidence: [] },
                    },
                    publicToolsWithoutOkOrExpectedError: [],
                    publicToolsWithoutEvidence: [],
                    publicToolsWithoutDirectOk: ["device_backends"],
                    publicToolsWithOnlyExpectedErrorEvidence: [],
                    unexplainedDiagnosticOnlyTools: [],
                    unjustifiedMissingDirectOkTools: ["device_backends"],
                    explainedProviderValues: ["backend=android-device", "backend=android-emulator"],
                    unexplainedProviderArgumentEnumFacets: [],
                    scriptedTools: ["device_backends", "device_broker_rpc", "display_current"],
                    scriptedPublicTools: ["device_backends", "display_current"],
                    scriptedHiddenCompatibilityTools: ["device_broker_rpc"],
                    scriptedArgumentFacets: ["device_broker_rpc:method=broker.status"],
                    uncalledAdvertisedTools: ["device_backends"],
                    unscriptedAdvertisedTools: [],
                    uncalledScriptedTools: ["device_backends"],
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
                        display_current: { total: 1, ok: 1, error: 0 },
                    },
                    flowStepToolOutcomeSummary: {
                        display_current: { total: 1, ok: 1, expectedError: 0, unexpectedError: 0 },
                    },
                    publicFlowStepTools: ["display_current"],
                    publicFlowStepToolsWithoutOkOrExpectedError: [],
                    expectedFlowStepErrorRecords: [
                        { test: "broker", flowTool: "mobile_run_flow", tool: "mobile_tap", isError: true, expectedError: true },
                    ],
                    unexpectedFlowStepErrorRecords: [],
                    expectedFlowStepPayloadFailures: [],
                    okPublicFlowStepPayloadFailures: [],
                    emptyOkPublicFlowStepPayloadRecords: [],
                    calls: [
                        { test: "display", tool: "display_current", mcpSessionId: "source-session-1" },
                        { test: "broker", tool: "device_broker_rpc", mcpSessionId: "source-session-1", outcome: "error-result", expectedError: true, errorPayloadJson: true, errorCode: "broker-unavailable" },
                    ],
                    scripted: [
                        { test: "display", tool: "display_current", source: "callTool" },
                        { test: "broker", tool: "device_broker_rpc", source: "callTool" },
                        { test: "backends", tool: "device_backends", source: "callTool" },
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
            const result = spawnSync(process.execPath, [join(repoRoot, "scripts", "real-tests", "summarize-json.mjs"), summaryFile], {
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
                    calledHiddenCompatibility: 1,
                    calledArgumentFacets: 1,
                    callOutcomes: { "error-result": 1, ok: 1 },
                    toolOutcomeSummary: {
                        display_current: { total: 1, ok: 1, expectedError: 0, unexpectedError: 0, incomplete: 0 },
                        device_broker_rpc: { total: 1, ok: 0, expectedError: 1, unexpectedError: 0, incomplete: 0 },
                    },
                    toolEvidenceSummary: {
                        display_current: { direct: { total: 1, ok: 1, expectedError: 0, unexpectedError: 0, incomplete: 0 }, flow: { total: 1, ok: 1, expectedError: 0, unexpectedError: 0 }, evidence: ["direct-ok", "flow-ok"] },
                        device_backends: { direct: { total: 0, ok: 0, expectedError: 0, unexpectedError: 0, incomplete: 0 }, flow: { total: 0, ok: 0, expectedError: 0, unexpectedError: 0 }, evidence: [] },
                    },
                    publicToolsWithoutOkOrExpectedError: [],
                    publicToolsWithoutEvidence: [],
                    publicToolsWithoutDirectOk: ["device_backends"],
                    publicToolsWithOnlyExpectedErrorEvidence: [],
                    unexplainedDiagnosticOnlyTools: [],
                    unjustifiedMissingDirectOkTools: ["device_backends"],
                    explainedProviderValues: ["backend=android-device", "backend=android-emulator"],
                    unexplainedProviderArgumentEnumFacets: [],
                    scripted: 3,
                    scriptedPublic: 2,
                    scriptedHiddenCompatibility: 1,
                    scriptedArgumentFacets: 1,
                    invalidScriptedArgumentFacets: [],
                    uncalledAdvertisedTools: ["device_backends"],
                    unscriptedAdvertisedTools: [],
                    uncalledScriptedTools: ["device_backends"],
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
                        display_current: { total: 1, ok: 1, error: 0 },
                    },
                    flowStepToolOutcomeSummary: {
                        display_current: { total: 1, ok: 1, expectedError: 0, unexpectedError: 0 },
                    },
                    publicFlowStepTools: ["display_current"],
                    publicFlowStepToolsWithoutOkOrExpectedError: [],
                    expectedFlowStepErrorRecords: [
                        { test: "broker", flowTool: "mobile_run_flow", tool: "mobile_tap", isError: true, expectedError: true },
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
                    advertisedTools: ["display_current"],
                    calledPublicTools: ["display_current"],
                    unscriptedAdvertisedTools: [],
                    uncalledAdvertisedTools: [],
                    publicToolsWithoutOkOrExpectedError: [],
                    toolEvidenceSummary: {
                        display_current: { direct: { total: 1, ok: 1, expectedError: 0, unexpectedError: 0, incomplete: 0 }, flow: { total: 0, ok: 0, expectedError: 0, unexpectedError: 0 }, evidence: ["direct-ok"] },
                    },
                    publicToolsWithoutEvidence: [],
                    publicToolsWithoutDirectOk: [],
                    publicToolsWithOnlyExpectedErrorEvidence: [],
                    calledAdvertisedArgumentEnumFacets: [],
                    uncalledScriptedTools: [],
                    uncalledScriptedArgumentFacets: [],
                    invalidScriptedArgumentFacets: [],
                    uncalledAdvertisedArgumentEnumFacets: ["device_status:backend=macos-vm", "device_create:provider=tart"],
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
                        { test: "display", tool: "display_current", outcome: "ok", mcpSessionId: "source-session-1" },
                        { test: "package", tool: "display_current", outcome: "ok", mcpSessionId: "dist-session-1" },
                    ],
                },
                mcpSessions: [
                    { test: "display", id: "source-session-1", name: "source-session", serverPath: "/repo/device-lab-mcp/server.mjs", serverSource: "source", serverFile: sourceServerFile, advertisedToolSurface, node: process.execPath, envOverrides: [] },
                    { test: "package", id: "dist-session-1", name: "dist-session", serverPath: "/repo/dist/device-lab-mcp/server.mjs", serverSource: "dist", serverFile: distServerFile, advertisedToolSurface, node: process.execPath, envOverrides: [] },
                ],
            };
            writeFileSync(passingFile, JSON.stringify(baseSummary));
            writeFileSync(failingFile, JSON.stringify({
                ...baseSummary,
                fail: 1,
                strictCoverageFailures: 1,
                skipCategories: [{ category: "other", count: 1, records: [{ test: "mystery", reason: "ambiguous skip" }] }],
                toolCoverage: {
                    ...baseSummary.toolCoverage,
                    unscriptedAdvertisedTools: ["device_backends"],
                    uncalledScriptedTools: ["device_backends"],
                    publicToolsWithoutOkOrExpectedError: ["device_backends"],
                    publicToolsWithoutEvidence: ["device_backends"],
                    invalidScriptedArgumentFacets: ["display_click:bogus=left"],
                    uncalledAdvertisedArgumentEnumFacets: [
                        "device_status:backend=macos-vm",
                        "display_scroll:direction=left",
                    ],
                    unexpectedErrorResultRecords: [{ test: "broker", tool: "device_broker_rpc" }],
                    argumentSchemaFailureRecords: [{ test: "display", tool: "display_click", schemaValid: false, schemaErrors: ["arguments.x:required"] }],
                    flowStepArgumentSchemaFailures: [{ test: "display", flowTool: "device_run_flow", index: 0, tool: "display_click", schemaErrors: ["arguments.x:required"], schemaErrorCount: 1 }],
                    expectedErrorPayloadFailures: [{ test: "broker", tool: "device_broker_rpc", expectedError: true }],
                    okPublicPayloadFailures: [{ test: "display", tool: "display_current", okPayloadText: true, okPayloadJson: false, okPayloadImage: false }],
                    emptyOkPublicPayloadRecords: [{ test: "display", tool: "display_current", okPayloadJson: true, okPayloadShape: { kind: "object", keys: [] } }],
                    publicFlowStepToolsWithoutOkOrExpectedError: ["display_current"],
                    unexpectedFlowStepErrorRecords: [{ test: "display", flowTool: "device_run_flow", tool: "display_current", isError: true }],
                    expectedFlowStepPayloadFailures: [{ test: "broker", flowTool: "mobile_run_flow", tool: "mobile_tap", isError: true, expectedError: true, errorPayloadJson: false }],
                    okPublicFlowStepPayloadFailures: [{ test: "display", flowTool: "device_run_flow", tool: "display_current", isError: false, okPayloadJson: false, okPayloadImage: false }],
                    emptyOkPublicFlowStepPayloadRecords: [{ test: "display", flowTool: "device_run_flow", tool: "display_current", isError: false, okPayloadJson: true, okPayloadShape: { kind: "object", keys: [] } }],
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
                    unexplainedProviderArgumentEnumFacets: ["device_status:backend=macos-vm"],
                    unexplainedDiagnosticOnlyTools: ["display_current"],
                    unjustifiedMissingDirectOkTools: ["display_current"],
                },
            }));
            writeFileSync(unexplainedDiagnosticOnlyFile, JSON.stringify({
                ...baseSummary,
                toolCoverage: {
                    ...baseSummary.toolCoverage,
                    advertisedTools: ["display_current", "device_backends"],
                    calledPublicTools: ["display_current", "device_backends"],
                    publicToolsWithOnlyExpectedErrorEvidence: ["device_backends"],
                    uncalledAdvertisedArgumentEnumFacets: [],
                    toolEvidenceSummary: {
                        ...baseSummary.toolCoverage.toolEvidenceSummary,
                        device_backends: { direct: { total: 1, ok: 0, expectedError: 1, unexpectedError: 0, incomplete: 0 }, flow: { total: 0, ok: 0, expectedError: 0, unexpectedError: 0 }, evidence: ["direct-expected-error"] },
                    },
                    calls: [
                        ...baseSummary.toolCoverage.calls,
                        { test: "display", tool: "device_backends", outcome: "expected-error", mcpSessionId: "source-session-1" },
                        { test: "package", tool: "device_backends", outcome: "expected-error", mcpSessionId: "dist-session-1" },
                    ],
                },
            }));
            writeFileSync(nonExemptDiagnosticOnlyFile, JSON.stringify({
                ...baseSummary,
                toolCoverage: {
                    ...baseSummary.toolCoverage,
                    advertisedTools: ["device_status"],
                    calledPublicTools: ["device_status"],
                    publicToolsWithoutDirectOk: ["device_status"],
                    publicToolsWithOnlyExpectedErrorEvidence: ["device_status"],
                    calledAdvertisedArgumentEnumFacets: ["device_status:backend=macos-vm"],
                    uncalledAdvertisedArgumentEnumFacets: [],
                    toolEvidenceSummary: {
                        device_status: { direct: { total: 1, ok: 0, expectedError: 1, unexpectedError: 0, incomplete: 0 }, flow: { total: 0, ok: 0, expectedError: 0, unexpectedError: 0 }, evidence: ["direct-expected-error"] },
                    },
                    calls: [
                        { test: "display", tool: "device_status", outcome: "expected-error", mcpSessionId: "source-session-1" },
                        { test: "package", tool: "device_status", outcome: "expected-error", mcpSessionId: "dist-session-1" },
                    ],
                },
            }));
            writeFileSync(missingDirectOkFile, JSON.stringify({
                ...baseSummary,
                toolCoverage: {
                    ...baseSummary.toolCoverage,
                    publicToolsWithoutDirectOk: ["display_current"],
                    toolEvidenceSummary: {
                        ...baseSummary.toolCoverage.toolEvidenceSummary,
                        display_current: { direct: { total: 0, ok: 0, expectedError: 0, unexpectedError: 0, incomplete: 0 }, flow: { total: 1, ok: 1, expectedError: 0, unexpectedError: 0 }, evidence: ["flow-ok"] },
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
                        { test: "display", tool: "display_current", outcome: "ok", mcpSessionId: "source-session-1" },
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
                        { test: "display", tool: "display_current", outcome: "ok", mcpSessionId: "source-session-1" },
                        { test: "package", tool: "display_current", outcome: "declared", mcpSessionId: "dist-session-1" },
                    ],
                },
            }));
            writeFileSync(missingSessionSourceDirectOkFile, JSON.stringify({
                ...baseSummary,
                toolCoverage: {
                    ...baseSummary.toolCoverage,
                    calls: [
                        { test: "display", tool: "display_current", outcome: "ok", mcpSessionId: "source-session-1" },
                        { test: "package", tool: "display_current", outcome: "error-result", expectedError: true, mcpSessionId: "dist-session-1" },
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
                        { test: "display", tool: "display_current", outcome: "ok", mcpSessionId: "missing-session" },
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
                publicToolsByMcpSessionSource: { dist: ["display_current"], source: ["display_current"] },
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
                unexplainedDiagnosticOnlyTools: ["device_backends"],
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
                unjustifiedMissingDirectOkTools: ["device_status"],
            }));

            const missingDirectOk = spawnSync(process.execPath, [runner, "--assert-json", missingDirectOkFile], {
                cwd: repoRoot,
                encoding: "utf-8",
            });
            expect(missingDirectOk.status).toBe(1);
            expect(JSON.parse(missingDirectOk.stdout)).toEqual(expect.objectContaining({
                ok: false,
                failures: ["unjustifiedMissingDirectOkTools=1"],
                unjustifiedMissingDirectOkTools: ["display_current"],
            }));

            const staleSurface = spawnSync(process.execPath, [runner, "--assert-json", staleSurfaceFile], {
                cwd: repoRoot,
                encoding: "utf-8",
            });
            expect(staleSurface.status).toBe(1);
            expect(JSON.parse(staleSurface.stdout)).toEqual(expect.objectContaining({
                ok: false,
                failures: ["canonicalToolSurfaceMismatch"],
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
                missingPublicToolsByMcpSessionSource: { dist: ["display_current"] },
            }));

            const platformResultCoverage = spawnSync(process.execPath, [runner, "--assert-json", missingSessionSourceCoverageFile, "--platform-result"], {
                cwd: repoRoot,
                encoding: "utf-8",
            });
            expect(platformResultCoverage.status).toBe(0);
            expect(JSON.parse(platformResultCoverage.stdout)).toEqual(expect.objectContaining({
                ok: true,
                failures: [],
                missingPublicToolsByMcpSessionSource: { dist: ["display_current"] },
            }));

            const missingSessionSourceDirectOk = spawnSync(process.execPath, [runner, "--assert-json", missingSessionSourceDirectOkFile], {
                cwd: repoRoot,
                encoding: "utf-8",
            });
            expect(missingSessionSourceDirectOk.status).toBe(1);
            expect(JSON.parse(missingSessionSourceDirectOk.stdout)).toEqual(expect.objectContaining({
                ok: false,
                failures: ["unjustifiedMissingDirectOkToolsByMcpSessionSource=1"],
                publicToolsWithoutDirectOkByMcpSessionSource: { dist: ["display_current"], source: [] },
                unjustifiedMissingDirectOkToolsByMcpSessionSource: { dist: ["display_current"] },
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
