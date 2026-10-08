import { decodeHostMcpServers, forwardHostMcpServers, freshManagedMcpServers } from "../domain/mcp-forward.js";
import { renderCodexManagedMcpConfig } from "../domain/mcp-managed-toml.js";
import type { McpConfigRegenerationPorts } from "../ports/mcp-forward.js";

/** Synchronous profile regeneration retains the existing separate publications. */
export function createMcpConfigRegenerator<ClaudeBinding, CodexBinding>(ports: McpConfigRegenerationPorts<ClaudeBinding, CodexBinding>) {
    for (const name of ["resolveClaudeProfile", "readClaudeProfileDocument", "readHostMcpDocument", "withCodexProfileLock", "prepareCodexProfile", "publishCodexProfile", "publishClaudeProfile"] as const) {
        if (!ports || typeof ports[name] !== "function") throw new TypeError(`MCP config regeneration requires ${name}`);
    }
    function build(profile?: string, restoreAccess?: () => void): string[] {
        const claude = ports.resolveClaudeProfile(profile);
        const document = ports.readClaudeProfileDocument(claude);
        let config: Record<string, unknown> = {};
        if (document !== undefined) {
            try { config = JSON.parse(document); }
            catch { config = {}; }
        }
        const mcpServers = freshManagedMcpServers();
        const hostServers = decodeHostMcpServers(ports.readHostMcpDocument());
        const forwarded = forwardHostMcpServers(mcpServers, hostServers);
        ports.withCodexProfileLock(profile, () => {
            restoreAccess?.();
            const {binding, existingText} = ports.prepareCodexProfile(profile);
            const next = renderCodexManagedMcpConfig(mcpServers, existingText);
            if (next !== existingText) ports.publishCodexProfile(binding, next);
        });
        config.mcpServers = mcpServers;
        ports.publishClaudeProfile(claude, JSON.stringify(config, null, 2));
        return forwarded;
    }
    return {build};
}
