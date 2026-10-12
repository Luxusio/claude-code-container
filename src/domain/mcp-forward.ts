export interface McpServerConfig {
    command?: string;
    args?: string[];
    url?: string;
    [key: string]: unknown;
}

export const RETIRED_X11_MCP_SERVERS = new Set([
    "/opt/ccc/x11-mcp/server.mjs",
    "/opt/ccc/dist/x11-mcp/server.mjs",
]);

function usesRetiredX11Server(server: McpServerConfig): boolean {
    return (typeof server.command === "string" && RETIRED_X11_MCP_SERVERS.has(server.command))
        || (Array.isArray(server.args) && server.args.some((arg) => RETIRED_X11_MCP_SERVERS.has(arg)));
}

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

export function selectHostMcpServers(parsed: unknown): Record<string, McpServerConfig> {
    const config = parsed as {mcpServers?: Record<string, McpServerConfig>} | null;
    if (config?.mcpServers && typeof config.mcpServers === "object") return config.mcpServers;
    return {};
}

export function forwardHostMcpServers(mcpServers: Record<string, McpServerConfig>, hostServers: Record<string, McpServerConfig>): string[] {
    const forwarded: string[] = [];
    for (const [name, server] of Object.entries(hostServers)) {
        if (name === "chrome-devtools") continue;
        if (name === "x11-display") continue;
        if (name === "device-lab") continue;
        if (name === "lab") continue;
        if (usesRetiredX11Server(server)) continue;
        if (name === "playwright") continue;
        mcpServers[name] = processServerForContainer(name, server);
        forwarded.push(name);
    }
    return forwarded;
}
