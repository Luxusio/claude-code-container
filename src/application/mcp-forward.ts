import { selectHostMcpServers, forwardHostMcpServers } from "../domain/mcp-forward.js";
import type { McpServerConfig } from "../domain/mcp-forward.js";
import { renderCodexManagedMcpConfig } from "../domain/mcp-managed-toml.js";
import type { McpConfigRegenerationPorts } from "../ports/mcp-forward.js";

/** Native read and host selection retain their shared fallback. */
export function readCurrentHostMcpServers(read: (() => string) | undefined): Record<string, McpServerConfig> {
    if (read === undefined) return {};
    try { return selectHostMcpServers(JSON.parse(read())); }
    catch { return {}; }
}

/** Synchronous profile regeneration retains the existing separate publications. */
export function createMcpConfigRegenerator<ClaudeBinding, CodexBinding>(ports: McpConfigRegenerationPorts<ClaudeBinding, CodexBinding>) {
    for (const name of ["resolveClaudeProfile", "readClaudeProfileDocument", "readHostMcpDocument", "createManagedMcpServers", "withCodexProfileLock", "prepareCodexProfile", "publishCodexProfile", "publishClaudeProfile"] as const) {
        if (!ports || typeof ports[name] !== "function") throw new TypeError(`MCP config regeneration requires ${name}`);
    }
    function build(profile?: string, restoreAccess?: () => void): string[] {
        const claude = ports.resolveClaudeProfile(profile);
        const readClaudeDocument = ports.readClaudeProfileDocument(claude);
        let config: Record<string, unknown> = {};
        if (readClaudeDocument !== undefined) {
            try { config = JSON.parse(readClaudeDocument()); }
            catch { config = {}; }
        }
        const managed = ports.createManagedMcpServers();
        const mcpServers: Record<string, McpServerConfig> = {
            "chrome-devtools": managed.chromeDevtools,
            "device-lab": managed.deviceLab,
        };
        const hostServers = readCurrentHostMcpServers(ports.readHostMcpDocument());
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
