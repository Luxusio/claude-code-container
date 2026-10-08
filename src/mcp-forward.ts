import { createMcpConfigRegenerator } from "./application/mcp-forward.js";
import { createNativeMcpConfigPorts, readHostMcpDocument } from "./adapters/mcp-forward.js";
import { decodeHostMcpServers } from "./domain/mcp-forward.js";
import type { McpServerConfig } from "./domain/mcp-forward.js";

export { rewriteLocalhostUrl, processServerForContainer } from "./domain/mcp-forward.js";

/** Read current host MCP definitions with the original permissive fallback. */
export function readHostMcpServers(): Record<string, McpServerConfig> {
    return decodeHostMcpServers(readHostMcpDocument());
}

/** Regenerate both profile configs synchronously on each fresh/reused exec. */
export function buildMcpConfig(profile?: string, restoreAccess?: () => void): string[] {
    return createMcpConfigRegenerator(createNativeMcpConfigPorts()).build(profile, restoreAccess);
}
