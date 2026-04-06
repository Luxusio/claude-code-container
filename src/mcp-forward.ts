import { existsSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { getClaudeJsonFile } from "./utils.js";

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
        "exec", "node@22", "--", "npx", "-y", "chrome-devtools-mcp",
        "--headless", "--isolated",
        "--executablePath=/usr/bin/chromium",
        "--chromeArg=--no-sandbox",
        "--chromeArg=--disable-setuid-sandbox",
        "--chromeArg=--disable-dev-shm-usage",
        "--chromeArg=--host-resolver-rules=MAP localhost host.docker.internal",
    ],
};

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
export function processServerForContainer(name: string, server: McpServerConfig): McpServerConfig {
    // SSE/HTTP server: rewrite URL
    if (server.url) {
        return { ...server, url: rewriteLocalhostUrl(server.url) };
    }
    // stdio server: forward as-is
    return { ...server };
}

/**
 * Build merged MCP config and write to the profile-specific claude.json file
 * Called on each exec() to ensure per-project isolation (no stale config from previous project)
 */
export function buildMcpConfig(profile?: string): string[] {
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

    // 2. Forward host MCP servers
    const hostServers = readHostMcpServers();
    for (const [name, server] of Object.entries(hostServers)) {
        // Skip chrome-devtools (ccc manages its own)
        if (name === "chrome-devtools") continue;
        // Skip playwright (legacy, removed)
        if (name === "playwright") continue;

        mcpServers[name] = processServerForContainer(name, server);
        forwarded.push(name);
    }

    config.mcpServers = mcpServers;
    writeFileSync(claudeJsonFile, JSON.stringify(config, null, 2), { mode: 0o600 });

    return forwarded;
}
