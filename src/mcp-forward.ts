import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { withCodexConfigLock } from "./codex-config-lock.js";
import { getClaudeJsonFile, getCodexConfigFile } from "./utils.js";

interface McpServerConfig {
    command?: string;
    args?: string[];
    url?: string;
    [key: string]: unknown;
}

// Chrome DevTools MCP config (always included, managed by ccc)
const CHROME_DEVTOOLS_CONFIG: McpServerConfig = {
    command: "mise",
    args: [
        "--no-config", "exec", "node@22", "--", "npx", "-y", "chrome-devtools-mcp",
        "--headless", "--isolated",
        "--executablePath=/usr/bin/chromium",
        "--chromeArg=--no-sandbox",
        "--chromeArg=--disable-setuid-sandbox",
        "--chromeArg=--disable-dev-shm-usage",
    ],
};

const OPT_DEVICE_LAB_MCP_SERVER = "/opt/ccc/dist/device-lab-mcp/server.mjs";
const RETIRED_X11_MCP_SERVERS = new Set([
    "/opt/ccc/x11-mcp/server.mjs",
    "/opt/ccc/dist/x11-mcp/server.mjs",
]);

function usesRetiredX11Server(server: McpServerConfig): boolean {
    return (typeof server.command === "string" && RETIRED_X11_MCP_SERVERS.has(server.command))
        || (Array.isArray(server.args) && server.args.some((arg) => RETIRED_X11_MCP_SERVERS.has(arg)));
}

function managedMcpServerConfig(serverPath: string): McpServerConfig {
    return {
        command: "mise",
        args: ["--no-config", "exec", "node@22", "--", "node", serverPath],
    };
}

const CODEX_MANAGED_BEGIN = "# ccc-managed-mcp begin";
const CODEX_MANAGED_END = "# ccc-managed-mcp end";

/**
 * Read MCP servers from host's ~/.claude.json
 */
export function readHostMcpServers(): Record<string, McpServerConfig> {
    const hostClaudeJson = join(homedir(), ".claude.json");
    if (!existsSync(hostClaudeJson)) return {};
    try {
        const config = JSON.parse(readFileSync(hostClaudeJson, "utf-8"));
        if (config?.mcpServers && typeof config.mcpServers === "object") {
            return config.mcpServers;
        }
    } catch { /* ignore */ }
    return {};
}

/**
 * Rewrite localhost/127.0.0.1 URLs to host.docker.internal for SSE/HTTP MCP servers
 */
export function rewriteLocalhostUrl(url: string): string {
    return url
        .replace(/\/\/localhost([:/?)#]|$)/g, "//host.docker.internal$1")
        .replace(/\/\/127\.0\.0\.1([:/?)#]|$)/g, "//host.docker.internal$1");
}

/**
 * Process a single MCP server config for container use
 * - stdio servers: forward as-is (command + args)
 * - HTTP/SSE servers: rewrite localhost URLs
 */
export function processServerForContainer(_name: string, server: McpServerConfig): McpServerConfig {
    // SSE/HTTP server: rewrite URL
    if (server.url) {
        return { ...server, url: rewriteLocalhostUrl(server.url) };
    }
    // stdio server: forward as-is
    return { ...server };
}

function quoteTomlString(value: string): string {
    return JSON.stringify(value);
}

function quoteTomlKey(key: string): string {
    return /^[A-Za-z0-9_-]+$/.test(key) ? key : quoteTomlString(key);
}

function tomlValue(value: unknown): string | undefined {
    if (typeof value === "string") return quoteTomlString(value);
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (typeof value === "boolean") return String(value);
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
        return `[${value.map((item) => quoteTomlString(item)).join(", ")}]`;
    }
    if (
        value
        && typeof value === "object"
        && !Array.isArray(value)
        && Object.values(value).every((item) => typeof item === "string")
    ) {
        const entries = Object.entries(value)
            .map(([key, item]) => `${quoteTomlKey(key)} = ${quoteTomlString(item as string)}`);
        return `{ ${entries.join(", ")} }`;
    }
    return undefined;
}

function codexMcpServerBlock(name: string, server: McpServerConfig): string {
    const lines = [`[mcp_servers.${quoteTomlKey(name)}]`];
    const orderedKeys = ["command", "args", "url", "env", "bearer_token_env_var"];
    const keys = [
        ...orderedKeys.filter((key) => Object.prototype.hasOwnProperty.call(server, key)),
        ...Object.keys(server)
            .filter((key) => !orderedKeys.includes(key))
            .sort(),
    ];

    for (const key of keys) {
        const value = tomlValue(server[key]);
        if (value === undefined) continue;
        lines.push(`${quoteTomlKey(key)} = ${value}`);
    }

    return lines.join("\n");
}

interface TomlStatement {
    raw: string;
    code: string;
}

function tomlStringEnd(text: string, start: number): number | undefined {
    const quote = text[start];
    if (quote !== '"' && quote !== "'") return undefined;
    const multiline = text.slice(start, start + 3) === quote.repeat(3);
    for (let i = start + (multiline ? 3 : 1); i < text.length; i += 1) {
        if (quote === '"' && text[i] === "\\") i += 1;
        else if (text[i] === quote) {
            if (!multiline) return i + 1;
            if (text.slice(i, i + 3) === quote.repeat(3)) {
                let end = i + 3;
                while (text[end] === quote) end += 1;
                return end - i <= 5 ? end : undefined;
            }
        }
    }
    return undefined;
}

// Keep raw user text, but recognize statements only outside strings, comments
// and nested values. A physical line in a multiline value is never a table.
function tomlStatements(text: string): TomlStatement[] {
    const statements: TomlStatement[] = [];
    let start = 0;
    let code = "";
    let comment = false;
    let depth = 0;
    for (let i = 0; i < text.length; i += 1) {
        const char = text[i];
        if (comment) {
            if (char !== "\n") continue;
            comment = false;
        } else if (char === "#") {
            comment = true;
            continue;
        } else if (char === '"' || char === "'") {
            const end = tomlStringEnd(text, i) ?? text.length;
            code += text.slice(i, end);
            i = end - 1;
            continue;
        } else if (char === "[" || char === "{") depth += 1;
        else if (char === "]" || char === "}") depth -= 1;

        code += char;
        if (char === "\n" && depth === 0) {
            statements.push({ raw: text.slice(start, i + 1), code });
            start = i + 1;
            code = "";
        }
    }
    if (start < text.length) statements.push({ raw: text.slice(start), code });
    return statements;
}

function tomlStringValue(value: string): string {
    const multiline = value.startsWith(value[0].repeat(3));
    const width = multiline ? 3 : 1;
    let body = value.slice(width, -width).replace(/\r\n/g, "\n");
    if (multiline) body = body.replace(/^\n/, "");
    if (value.startsWith("'")) return body;
    const escapes: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
    let decoded = "";
    for (let i = 0; i < body.length; i += 1) {
        if (body[i] !== "\\") {
            decoded += body[i];
            continue;
        }
        i += 1;
        const continuation = multiline ? /^[ \t]*\n[ \t\n]*/.exec(body.slice(i)) : null;
        if (continuation) {
            i += continuation[0].length - 1;
            continue;
        }
        const escape = body[i];
        if (escape === "u" || escape === "U") {
            const width = escape === "u" ? 4 : 8;
            const hex = body.slice(i + 1, i + 1 + width);
            if (hex.length !== width || !/^[0-9A-Fa-f]+$/.test(hex)) throw new SyntaxError("Invalid TOML Unicode escape");
            const point = Number.parseInt(hex, 16);
            if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) throw new SyntaxError("Invalid TOML Unicode scalar");
            decoded += String.fromCodePoint(point);
            i += width;
        } else {
            if (!Object.hasOwn(escapes, escape)) throw new SyntaxError("Invalid TOML string escape");
            decoded += escapes[escape];
        }
    }
    return decoded;
}

function tomlKeyComponents(text: string): string[] | undefined {
    const keys: string[] = [];
    let offset = 0;
    while (offset < text.length) {
        while (/[ \t]/.test(text[offset] || "")) offset += 1;
        if (text[offset] === '"' || text[offset] === "'") {
            if (text.slice(offset, offset + 3) === text[offset].repeat(3)) return undefined;
            const end = tomlStringEnd(text, offset);
            if (end === undefined) return undefined;
            keys.push(tomlStringValue(text.slice(offset, end)));
            offset = end;
        } else {
            const bare = /^[A-Za-z0-9_-]+/.exec(text.slice(offset));
            if (!bare) return undefined;
            keys.push(bare[0]);
            offset += bare[0].length;
        }
        while (/[ \t]/.test(text[offset] || "")) offset += 1;
        if (offset === text.length) return keys;
        if (text[offset] !== ".") return undefined;
        offset += 1;
    }
    return undefined;
}

function codexMcpTable(line: string): { name: string; nested: boolean } | undefined {
    const header = line.trim();
    if (!header.startsWith("[") || header.startsWith("[[") || !header.endsWith("]")) return undefined;
    try {
        const keys = tomlKeyComponents(header.slice(1, -1).trim());
        if (!keys || keys[0] !== "mcp_servers" || keys.length < 2) return undefined;
        return { name: keys[1], nested: keys.length > 2 };
    } catch {
        return undefined;
    }
}

function isTomlTableHeader(line: string): boolean {
    return /^\s*\[{1,2}(?:[^\]"']|"(?:[^"\\]|\\.)*"|'[^']*')+\]{1,2}\s*(?:#.*)?$/.test(line);
}

function tomlStringArray(value: string): string[] | undefined {
    if (!value.startsWith("[") || !value.endsWith("]")) return undefined;
    const values: string[] = [];
    let offset = 1;
    while (offset < value.length - 1) {
        while (/\s/.test(value[offset] || "")) offset += 1;
        if (offset === value.length - 1) break;
        const end = tomlStringEnd(value, offset);
        if (end === undefined || end >= value.length) return undefined;
        values.push(tomlStringValue(value.slice(offset, end)));
        offset = end;
        while (/\s/.test(value[offset] || "")) offset += 1;
        if (offset === value.length - 1) break;
        if (value[offset] !== ",") return undefined;
        offset += 1;
    }
    return values;
}

function codexAssignmentUsesRetiredX11Server(code: string): boolean {
    // This is one real root-table assignment, never text inside an env value.
    const assignment = /^\s*("(?:[^"\\\n]|\\.)*"|'[^'\n]*'|[A-Za-z0-9_-]+)\s*=([\s\S]*)$/.exec(code);
    if (!assignment) return false;
    let key: string;
    try {
        key = assignment[1].startsWith('"') || assignment[1].startsWith("'") ? tomlStringValue(assignment[1]) : assignment[1];
    } catch {
        return false;
    }
    if (key !== "command" && key !== "args") return false;
    const value = assignment[2].trim();
    try {
        const values = key === "args" ? tomlStringArray(value)
            : tomlStringEnd(value, 0) === value.length ? [tomlStringValue(value)] : undefined;
        return values?.some((token) => RETIRED_X11_MCP_SERVERS.has(token)) || false;
    } catch {
        return false; // preserve unrecognized user configuration
    }
}

function stripCodexManagedMcpTables(configToml: string): string {
    const statements = tomlStatements(configToml);
    const unmanaged: TomlStatement[] = [];
    for (let i = 0; i < statements.length; i += 1) {
        if (statements[i].raw.trim() === CODEX_MANAGED_BEGIN) {
            const end = statements.findIndex((statement, index) => index > i && statement.raw.trim() === CODEX_MANAGED_END);
            if (end !== -1) {
                i = end;
                continue;
            }
        }
        unmanaged.push(statements[i]);
    }
    const removedNames = new Set(["chrome-devtools", "x11-display", "device-lab", "lab"]);

    // Collect aliases first so even a subtable before its root is removed.
    let table: ReturnType<typeof codexMcpTable>;
    for (const statement of unmanaged) {
        if (isTomlTableHeader(statement.code)) table = codexMcpTable(statement.code);
        else if (table && !table.nested && codexAssignmentUsesRetiredX11Server(statement.code)) removedNames.add(table.name);
    }

    const kept: string[] = [];
    let remove = false;
    for (const statement of unmanaged) {
        if (isTomlTableHeader(statement.code)) {
            const current = codexMcpTable(statement.code);
            remove = Boolean(current && removedNames.has(current.name));
        }
        if (!remove) kept.push(statement.raw);
    }

    return kept.join("").trimEnd();
}

function isPermissionError(error: unknown): boolean {
    return typeof error === "object"
        && error !== null
        && "code" in error
        && (error.code === "EACCES" || error.code === "EPERM");
}

function codexConfigAccessError(action: "create" | "read" | "write", file: string, error: unknown): Error {
    const reason = error instanceof Error ? error.message : String(error);
    const hint = isPermissionError(error)
        ? ` This usually means ${file} or one of its parent directories is owned by another user. Fix it with: sudo chown -R "$USER:$USER" "${dirname(file)}"`
        : "";
    return new Error(`Unable to ${action} Codex config at ${file}: ${reason}.${hint}`);
}

function writeCodexMcpConfig(mcpServers: Record<string, McpServerConfig>, profile?: string, restoreAccess?: () => void): void {
    withCodexConfigLock(() => {
        restoreAccess?.();
        writeCodexMcpConfigUnlocked(mcpServers, profile);
    }, profile);
}

function writeCodexMcpConfigUnlocked(mcpServers: Record<string, McpServerConfig>, profile?: string): void {
    const codexConfigFile = getCodexConfigFile(profile);
    try {
        mkdirSync(dirname(codexConfigFile), { recursive: true });
    } catch (error) {
        throw codexConfigAccessError("create", codexConfigFile, error);
    }

    let existing = "";
    if (existsSync(codexConfigFile)) {
        try {
            existing = readFileSync(codexConfigFile, "utf-8");
        } catch (error) {
            throw codexConfigAccessError("read", codexConfigFile, error);
        }
    }

    const managedBlock = [
        CODEX_MANAGED_BEGIN,
        "# This block is regenerated by ccc on every run.",
        ...Object.entries(mcpServers).map(([name, server]) => codexMcpServerBlock(name, server)),
        CODEX_MANAGED_END,
    ].join("\n\n");

    const preserved = stripCodexManagedMcpTables(existing);
    const nextConfig = preserved
        ? `${preserved}\n\n${managedBlock}\n`
        : `${managedBlock}\n`;
    if (nextConfig === existing) return;

    try {
        writeFileSync(codexConfigFile, nextConfig, { mode: 0o600 });
    } catch (error) {
        throw codexConfigAccessError("write", codexConfigFile, error);
    }
}

/**
 * Build merged MCP config and write to Claude and Codex config files.
 * Called on each exec() to ensure per-project isolation (no stale config from previous project)
 */
export function buildMcpConfig(profile?: string, restoreAccess?: () => void): string[] {
    const claudeJsonFile = getClaudeJsonFile(profile);
    const forwarded: string[] = [];

    // Start with existing non-MCP config from claudeJsonFile
    let config: Record<string, unknown> = {};
    if (existsSync(claudeJsonFile)) {
        try {
            config = JSON.parse(readFileSync(claudeJsonFile, "utf-8"));
        } catch {
            config = {};
        }
    }

    // Build fresh MCP servers (always regenerate, never accumulate)
    const mcpServers: Record<string, McpServerConfig> = {};

    // 1. Always include chrome-devtools (ccc-managed)
    mcpServers["chrome-devtools"] = CHROME_DEVTOOLS_CONFIG;

    // 2. Device Lab owns unified screenshot/click/move/type for all devices.
    mcpServers["device-lab"] = {
        ...managedMcpServerConfig(OPT_DEVICE_LAB_MCP_SERVER),
        env: { CCC_DEVICE_BROKER_AUTH_FILE: "/run/ccc-device-broker-auth/owner.json" },
    };

    // 3. Forward host MCP servers
    const hostServers = readHostMcpServers();
    for (const [name, server] of Object.entries(hostServers)) {
        // Skip ccc-managed servers
        if (name === "chrome-devtools") continue;
        if (name === "x11-display") continue;
        if (name === "device-lab") continue;
        if (name === "lab") continue;
        if (usesRetiredX11Server(server)) continue;
        // Skip playwright (legacy, removed)
        if (name === "playwright") continue;

        mcpServers[name] = processServerForContainer(name, server);
        forwarded.push(name);
    }

    writeCodexMcpConfig(mcpServers, profile, restoreAccess);

    config.mcpServers = mcpServers;
    writeFileSync(claudeJsonFile, JSON.stringify(config, null, 2), { mode: 0o600 });

    return forwarded;
}
